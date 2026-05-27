import asyncio
import os
import shutil
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

from app.bases.interfaces import Worker
from app.bases.models import TaskStage, TaskStatus
from .config import ffmpegPaths

try:
    from features.http_pack.task import HttpTaskStage, HttpWorker
except ImportError:
    from http_pack.task import HttpTaskStage, HttpWorker


@dataclass(kw_only=True)
class FFmpegMergeSourceStage(HttpTaskStage):
    mergeKind: str
    mergeExtension: str = ""

    def updateOutputFile(self, taskPath: Path, taskTitle: str):
        stem = Path(taskTitle).stem
        suffix = f".{self.mergeExtension}" if self.mergeExtension else ""
        self.outputFile = str(taskPath / f"{stem}.{self.mergeKind}{suffix}")


@dataclass(kw_only=True)
class FFmpegStage(TaskStage):
    workerType: type = field(init=False, repr=False)
    canPause: bool = field(init=False, default=False)

    videoPath: str
    audioPath: str
    outputFile: str = ""
    cleanupSource: bool = True

    def updateOutputFile(self, taskPath: Path, taskTitle: str):
        pass


@dataclass(kw_only=True)
class FFmpegMergeStage(FFmpegStage):
    videoExtension: str = ""
    audioExtension: str = ""

    def updateOutputFile(self, taskPath: Path, taskTitle: str):
        stem = Path(taskTitle).stem
        videoSuffix = f".{self.videoExtension}" if self.videoExtension else ""
        audioSuffix = f".{self.audioExtension}" if self.audioExtension else ""
        self.outputFile = str(taskPath / f"{stem}.mp4")
        self.videoPath = str(taskPath / f"{stem}.video{videoSuffix}")
        self.audioPath = str(taskPath / f"{stem}.audio{audioSuffix}")


class FFmpegWorker(Worker):
    def __init__(self, stage: FFmpegStage):
        super().__init__(stage)
        self.stage = stage

    @staticmethod
    def _parseDuration(value) -> float:
        try:
            duration = float(value)
        except (TypeError, ValueError):
            return 0.0
        return duration if duration > 0 else 0.0

    async def _fetchDuration(self, ffprobe: str, path: str, cwd: Path | None = None) -> float:
        process = await asyncio.create_subprocess_exec(
            ffprobe,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            message = stderr.decode("utf-8", errors="ignore").strip()
            logger.warning("ffprobe 获取时长失败: {}, {}", path, message or process.returncode)
            return 0.0

        return self._parseDuration(stdout.decode("utf-8", errors="ignore").strip())

    async def _readProgress(self, stream: asyncio.StreamReader | None, totalDuration: float):
        if stream is None:
            return

        while True:
            rawLine = await stream.readline()
            if not rawLine:
                break

            line = rawLine.decode("utf-8", errors="ignore").strip()
            if not line:
                continue

            if line.startswith("out_time_us=") and totalDuration > 0:
                currentDuration = self._parseDuration(line.removeprefix("out_time_us=")) / 1_000_000
                if currentDuration <= 0:
                    continue
                self.stage.progress = min(99.5, max(0.0, currentDuration / totalDuration * 100))
            elif line == "progress=end":
                self.stage.progress = 100

    def _asciiWorkDir(self, outputFile: Path) -> Path:
        return outputFile.parent / f".gd3_ffmpeg_ascii_{self.stage.stageId}"

    @staticmethod
    def _linkOrCopy(source: Path, target: Path):
        if target.exists() or target.is_symlink():
            target.unlink()

        if not source.is_file():
            raise FileNotFoundError(f"FFmpeg source file not found: {source}")

        try:
            os.link(source, target)
        except OSError:
            shutil.copy2(source, target)

    def _prepareAsciiWorkspace(self, workDir: Path) -> tuple[Path, Path, Path]:
        if workDir.exists():
            shutil.rmtree(workDir)
        workDir.mkdir(parents=True, exist_ok=True)

        videoPath = workDir / "video.m4s"
        audioPath = workDir / "audio.m4s"
        outputPath = workDir / "output.mp4"
        self._linkOrCopy(Path(self.stage.videoPath), videoPath)
        self._linkOrCopy(Path(self.stage.audioPath), audioPath)
        return videoPath, audioPath, outputPath

    @staticmethod
    async def _killProcess(process):
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()

    async def run(self):
        ffmpeg, ffprobe = ffmpegPaths()
        if not ffmpeg or not ffprobe:
            raise RuntimeError("未找到可用的 ffmpeg 和 ffprobe，请先在设置中安装或配置 FFmpeg")

        outputFile = Path(self.stage.outputFile)
        outputFile.parent.mkdir(parents=True, exist_ok=True)
        workDir = self._asciiWorkDir(outputFile)

        process = None
        progressTask = None
        try:
            videoPath, audioPath, tempOutputFile = self._prepareAsciiWorkspace(workDir)
            self.stage.progress = 0
            self.stage.speed = 0
            self.stage.receivedBytes = 0
            totalDuration = await self._fetchDuration(ffprobe, videoPath.name, workDir)
            process = await asyncio.create_subprocess_exec(
                ffmpeg,
                "-y", "-v", "error", "-nostats", "-progress", "pipe:1",
                "-i", videoPath.name,
                "-i", audioPath.name,
                "-c", "copy",
                tempOutputFile.name,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workDir,
            )
            progressTask = asyncio.create_task(self._readProgress(process.stdout, totalDuration))

            await process.wait()
            await progressTask
            stderrOutput = ""
            if process.stderr is not None:
                stderrOutput = (await process.stderr.read()).decode("utf-8", errors="ignore").strip()
            if process.returncode != 0:
                if stderrOutput:
                    raise RuntimeError(f"ffmpeg 退出码异常: {process.returncode}, {stderrOutput}")
                raise RuntimeError(f"ffmpeg 退出码异常: {process.returncode}")

            os.replace(tempOutputFile, outputFile)
            self.stage.setStatus(TaskStatus.COMPLETED)
            if self.stage.cleanupSource:
                self._cleanupSourceFiles()
        except asyncio.CancelledError:
            self.stage.setStatus(TaskStatus.PAUSED)
            await self._killProcess(process)
            if progressTask is not None and not progressTask.done():
                progressTask.cancel()
                with suppress(asyncio.CancelledError):
                    await progressTask
            raise
        except Exception as e:
            await self._killProcess(process)
            self.stage.setError(e)
            raise
        finally:
            if progressTask is not None and not progressTask.done():
                progressTask.cancel()
                with suppress(asyncio.CancelledError):
                    await progressTask
            with suppress(Exception):
                shutil.rmtree(workDir)

    def _cleanupSourceFiles(self):
        for rawPath in (self.stage.videoPath, self.stage.audioPath):
            target = Path(rawPath)
            for path in (target, Path(rawPath + ".ghd")):
                try:
                    if path.is_file() or path.is_symlink():
                        path.unlink()
                except FileNotFoundError:
                    continue
                except Exception as e:
                    logger.opt(exception=e).error("failed to cleanup temporary file {}", path)


FFmpegStage.workerType = FFmpegWorker
FFmpegMergeStage.workerType = FFmpegWorker
FFmpegMergeSourceStage.workerType = HttpWorker
