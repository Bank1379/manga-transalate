import os
import sys
import subprocess
import time
import httpx
import logging
from server import config

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ScanLate-EngineProcess")

class EngineProcessManager:
    _instance = None

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self):
        self.process = None
        self.port = config.MIT_SERVER_PORT
        self.url = config.MIT_SERVER_URL
        self._health_cache = None   # (result: bool, timestamp: float)
        self._health_cache_ttl = 5.0  # seconds

    def _get_env(self):
        # Create env dictionary with isolated folders from config
        env = os.environ.copy()
        
        # Self-contained paths
        env["PYTHONPATH"] = os.path.join(config.ROOT_DIR, "engine", "manga-image-translator")
        if "PYTHONPATH" in os.environ:
            env["PYTHONPATH"] += os.pathsep + os.environ["PYTHONPATH"]
            
        env["PYTHONUSERBASE"] = os.path.join(config.ROOT_DIR, "runtime", "pyuserbase")
        env["PIP_CACHE_DIR"] = os.path.join(config.ROOT_DIR, "runtime", "pip-cache")
        env["TORCH_HOME"] = os.path.join(config.ROOT_DIR, "runtime", "torch-home")
        env["HF_HOME"] = os.path.join(config.ROOT_DIR, "runtime", "hf-home")
        env["XDG_CACHE_HOME"] = os.path.join(config.ROOT_DIR, "runtime", "xdg-cache")
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:128"
        
        return env

    def is_running(self):
        if self.process is None:
            return False
        # poll() returns None if process is still running
        return self.process.poll() is None

    async def is_healthy(self):
        if not self.is_running():
            self._health_cache = None
            return False
        # Return cached result if still fresh
        if self._health_cache is not None:
            cached_result, cached_at = self._health_cache
            if (time.time() - cached_at) < self._health_cache_ttl:
                return cached_result
        try:
            async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
                # The engine in 'shared' mode returns 404 for the root endpoint, which means it is alive.
                response = await client.get(self.url)
                result = response.status_code in (200, 404)
        except Exception as e:
            logger.warning(f"Engine health check failed: {e}")
            result = False
        
        # Only cache healthy responses to avoid blocking startup checks
        if result:
            self._health_cache = (result, time.time())
            
        return result

    def start(self):
        if self.is_running():
            logger.info("Engine process is already running.")
            return True

        logger.info(f"Starting manga-image-translator engine on port {self.port}...")
        
        python_exe = os.path.join(config.ROOT_DIR, "runtime", "python", "python.exe")
        if not os.path.exists(python_exe):
            # Fallback to system python if runtime python doesn't exist (e.g. during development testing)
            python_exe = sys.executable

        # Command to start the manga-image-translator server.main REST API server
        # Run as a script (not -m module) so relative imports like `from args import...` resolve correctly
        engine_server_script = os.path.join(config.ROOT_DIR, "engine", "manga-image-translator", "server", "main.py")
        cmd = [
            python_exe,
            engine_server_script,
            "--host", "127.0.0.1",
            "--port", str(self.port),
            "--start-instance",
            "--nonce", "None"
        ]
        if config.DEVICE == "cuda":
            cmd.append("--use-gpu")

        env = self._get_env()
        
        try:
            # We open stdout and stderr to a log file inside runtime/logs
            log_dir = os.path.join(config.ROOT_DIR, "runtime", "logs")
            os.makedirs(log_dir, exist_ok=True)
            log_file_path = os.path.join(log_dir, "engine.log")
            self.log_file = open(log_file_path, "a", encoding="utf-8")
            
            # Start process
            self.process = subprocess.Popen(
                cmd,
                cwd=os.path.join(config.ROOT_DIR, "engine", "manga-image-translator"),
                env=env,
                stdout=self.log_file,
                stderr=subprocess.STDOUT
            )
            
            logger.info(f"Engine subprocess spawned with PID: {self.process.pid}")
            return True
        except Exception as e:
            logger.error(f"Failed to start engine subprocess: {e}")
            return False

    async def wait_until_ready(self, timeout_sec=30):
        logger.info("Waiting for engine to respond...")
        start_time = time.time()
        while time.time() - start_time < timeout_sec:
            if not self.is_running():
                logger.error("Engine process terminated unexpectedly during startup.")
                return False
            if await self.is_healthy():
                logger.info("Engine is healthy and ready to accept requests.")
                return True
            import asyncio
            await asyncio.sleep(1)
        logger.error(f"Engine failed to become ready within {timeout_sec} seconds.")
        return False

    def stop(self):
        if not self.is_running():
            logger.info("Engine process is not running.")
            return

        logger.info(f"Stopping engine process (PID: {self.process.pid})...")
        try:
            self.process.terminate()
            # Wait up to 5 seconds for normal termination
            try:
                self.process.wait(timeout=5)
                logger.info("Engine process terminated gracefully.")
            except subprocess.TimeoutExpired:
                logger.warning("Engine did not terminate within 5 seconds. Killing process...")
                self.process.kill()
                self.process.wait()
                logger.info("Engine process killed.")
        except Exception as e:
            logger.error(f"Error stopping engine process: {e}")
        finally:
            self.process = None
            if hasattr(self, "log_file") and self.log_file:
                self.log_file.close()

# Helper accessors
def start_engine():
    mgr = EngineProcessManager.get_instance()
    return mgr.start()

async def wait_until_ready(timeout_sec=30):
    mgr = EngineProcessManager.get_instance()
    return await mgr.wait_until_ready(timeout_sec)

def stop_engine():
    mgr = EngineProcessManager.get_instance()
    mgr.stop()

async def check_engine_health():
    mgr = EngineProcessManager.get_instance()
    return await mgr.is_healthy()

def get_engine_pid():
    mgr = EngineProcessManager.get_instance()
    return mgr.process.pid if mgr.is_running() else None
