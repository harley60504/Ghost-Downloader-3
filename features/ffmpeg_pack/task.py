import asyncio
import os
import shutil
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

from app.bases.interfaces import Worker
from app.bases.models import TaskStage, TaskStatus
from .config import ffmpegPaths

if TYPE_CHECKING:
    from features.http_pack.task import HttpTaskStage
else:
    from http_pack.task import HttpTaskStage


def _baseTitle(taskTitle: str) -> str:
    return taskTitle[:-4] if taskTitle.lower().endswith(".mp4") else taskTitle


@dataclass(kw_only=True)
class FFmpegResourceStage(HttpTaskStage):
    # role ∈ {"video", "audio"}：合并任务里两路源各自的角色，落盘文件名带这个中缀
    role: str = "video"
    extension: str = ""

    @property
    def outputFile(self) -> str:
        suffix = f".{self.extension}" if self.extension else ""
        return str(Path(self.task.path) / f"{_baseTitle(self.task.title)}.{self.role}{suffix}")


def _parseDuration(value: str) -> float:
    try:
        return max(0.0, float(value))
    except ValueError:
        return 0.0


async def _probeDuration(ffprobe: str, path: Path | str, cwd: Path | None = None) -> float:
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

    return _parseDuration(stdout.decode("utf-8", errors="ignore").strip())


@dataclass(kw_only=True)
class FFmpegStage(TaskStage):
    workerType: type = field(init=False, repr=False)
    canPause: bool = field(init=False, default=False)

    videoExtension: str = ""
    audioExtension: str = ""
    cleanupSource: bool = True

    @property
    def outputFile(self) -> Path:
        return Path(self.task.path) / f"{_baseTitle(self.task.title)}.mp4"

    @property
    def videoPath(self) -> Path:
        suffix = f".{self.videoExtension}" if self.videoExtension else ""
        return Path(self.task.path) / f"{_baseTitle(self.task.title)}.video{suffix}"

    @property
    def audioPath(self) -> Path:
        suffix = f".{self.audioExtension}" if self.audioExtension else ""
        return Path(self.task.path) / f"{_baseTitle(self.task.title)}.audio{suffix}"


class FFmpegWorker(Worker):
    def __init__(self, stage: FFmpegStage):
        super().__init__(stage)
        self.stage = stage

    async def _readProgress(self, stream: asyncio.StreamReader, totalDuration: float):
        while True:
            rawLine = await stream.readline()
            if not rawLine:
                break

            line = rawLine.decode("utf-8", errors="ignore").strip()
            if not line:
                continue

            if line.startswith("out_time_us=") and totalDuration > 0:
                currentDuration = _parseDuration(line.removeprefix("out_time_us=")) / 1_000_000
                if currentDuration <= 0:
                    continue
                self.stage.progress = min(99.5, max(0.0, currentDuration / totalDuration * 100))
            elif line == "progress=end":
                self.stage.progress = 100

    def _asciiWorkDir(self) -> Path:
        return self.stage.outputFile.parent / f".gd3_ffmpeg_ascii_{self.stage.stageId}"

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
        self._linkOrCopy(self.stage.videoPath, videoPath)
        self._linkOrCopy(self.stage.audioPath, audioPath)
        return videoPath, audioPath, outputPath

    @staticmethod
    async def _killProcess(process):
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()

    def _cleanupSourceFiles(self):
        # 同时清理 HttpWorker 写下的 .ghd 临时元数据文件
        for path in (self.stage.videoPath, self.stage.audioPath):
            for target in (path, path.with_name(f"{path.name}.ghd")):
                try:
                    target.unlink(missing_ok=True)
                except OSError as e:
                    logger.opt(exception=e).warning("failed to cleanup temporary file {}", target)

    async def run(self):
        ffmpeg, ffprobe = ffmpegPaths()
        if not ffmpeg or not ffprobe:
            raise RuntimeError("未找到可用的 ffmpeg 和 ffprobe，请先在设置中安装或配置 FFmpeg")

        self.stage.outputFile.parent.mkdir(parents=True, exist_ok=True)
        workDir = self._asciiWorkDir()

        process = None
        progressTask = None
        try:
            videoPath, audioPath, tempOutputFile = self._prepareAsciiWorkspace(workDir)
            totalDuration = await _probeDuration(ffprobe, videoPath.name, workDir)
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
            if process.returncode != 0:
                stderrOutput = (await process.stderr.read()).decode("utf-8", errors="ignore").strip()
                suffix = f", {stderrOutput}" if stderrOutput else ""
                raise RuntimeError(f"ffmpeg 退出码异常: {process.returncode}{suffix}")

            os.replace(tempOutputFile, self.stage.outputFile)
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


FFmpegStage.workerType = FFmpegWorker
