import os
from dotenv import load_dotenv, set_key

# Load .env file if exists
load_dotenv()

# Root directory of the ScanLate project
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_PATH = os.path.join(ROOT_DIR, ".env")

# Server Configurations
SERVER_PORT = int(os.getenv("SERVER_PORT", "8745"))
MIT_SERVER_PORT = int(os.getenv("MIT_SERVER_PORT", "8000"))
MIT_SERVER_URL = os.getenv("MIT_SERVER_URL", f"http://127.0.0.1:{MIT_SERVER_PORT}")

# Security Settings
_keys_str = os.getenv("CLIENT_ACCESS_KEYS", "")
CLIENT_ACCESS_KEYS = [k.strip() for k in _keys_str.split(",") if k.strip()]

def update_client_access_keys(keys_list: list[str]):
    global CLIENT_ACCESS_KEYS
    CLIENT_ACCESS_KEYS = [k.strip() for k in keys_list if k.strip()]
    keys_str = ",".join(CLIENT_ACCESS_KEYS)
    # Ensure .env file exists
    if not os.path.exists(ENV_PATH):
        open(ENV_PATH, 'a').close()
    set_key(ENV_PATH, "CLIENT_ACCESS_KEYS", keys_str)

def update_llm_config_env(provider: str, model: str, api_key: str = "", ollama_url: str = ""):
    if not os.path.exists(ENV_PATH):
        open(ENV_PATH, 'a').close()
    
    set_key(ENV_PATH, "LLM_PROVIDER", provider)
    set_key(ENV_PATH, "LLM_MODEL", model)
    
    if provider == "gemini":
        set_key(ENV_PATH, "GOOGLE_API_KEY", api_key)
    elif provider == "openrouter":
        set_key(ENV_PATH, "OPENROUTER_API_KEY", api_key)
    elif provider == "openai":
        set_key(ENV_PATH, "OPENAI_API_KEY", api_key)
    elif provider == "ollama":
        set_key(ENV_PATH, "OLLAMA_URL", ollama_url)

# GPU Settings
DEVICE = os.getenv("DEVICE", "cuda")
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "1"))
MAX_CONCURRENT_TRANSLATIONS = int(os.getenv("MAX_CONCURRENT_TRANSLATIONS", "1"))
FP16 = os.getenv("FP16", "True").lower() in ("true", "1", "yes")

# LLM Settings
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openrouter")
LLM_MODEL = os.getenv("LLM_MODEL", "google/gemini-2.5-flash-lite")
MAX_CONCURRENT_LLM = int(os.getenv("MAX_CONCURRENT_LLM", "2"))
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY") or ""
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")

# Data & Cache Directories
DATA_DIR = os.path.join(ROOT_DIR, "data")
PROFILES_DIR = os.path.join(DATA_DIR, "profiles")
FONTS_DIR = os.path.join(DATA_DIR, "fonts")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
CACHE_MAX_SIZE_GB = float(os.getenv("CACHE_MAX_SIZE_GB", "10.0"))

# Default Font Settings
DEFAULT_FONT = os.getenv("DEFAULT_FONT", "Kanit-Bold")

# Ensure necessary folders exist
for folder in [DATA_DIR, PROFILES_DIR, FONTS_DIR, CACHE_DIR]:
    os.makedirs(folder, exist_ok=True)
