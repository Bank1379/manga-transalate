import os
import sys
import urllib.request

def main():
    print("--- ScanLate Engine Patch & Model Downloader ---")
    
    # Setup Paths
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    share_path = os.path.join(root_dir, "engine", "manga-image-translator", "manga_translator", "mode", "share.py")
    
    # 1. Patch share.py for fractions and deadlock
    if not os.path.exists(share_path):
        print(f"[ERROR] share.py not found at {share_path}")
        sys.exit(1)
        
    print(f"Patching {share_path}...")
    with open(share_path, "r", encoding="utf-8") as f:
        content = f.read()
        
    # Patch SAFE_PICKLE_MODULES to include 'fractions'
    old_safe = """SAFE_PICKLE_MODULES = frozenset({
    'builtins',
    'collections',
    'numpy',
    'numpy.core.multiarray',
    'numpy.dtype',
    'manga_translator',
    'manga_translator.utils',
    'manga_translator.utils.generic',
    'manga_translator.config'
})"""

    new_safe = """SAFE_PICKLE_MODULES = frozenset({
    'builtins',
    'collections',
    'numpy',
    'numpy.core.multiarray',
    'numpy.dtype',
    'manga_translator',
    'manga_translator.utils',
    'manga_translator.utils.generic',
    'manga_translator.config',
    'fractions'
})"""

    if old_safe in content:
        content = content.replace(old_safe, new_safe)
        print("  - SAFE_PICKLE_MODULES: Patched successfully.")
    else:
        if "'manga_translator.config'" in content and "'fractions'" not in content:
            content = content.replace("'manga_translator.config'", "'manga_translator.config',\n    'fractions'")
            print("  - SAFE_PICKLE_MODULES: Patched successfully (fallback).")
        else:
            print("  - SAFE_PICKLE_MODULES: Already patched or not matched.")
            
    # Patch simple_execute lock (move check_lock below restricted_loads)
    old_simple = """        @app.post("/simple_execute/{method_name}")
        async def execute_method(request: Request, method_name: str = Path(...)):
            self.check_nonce(request)
            self.check_lock()
            method = self.get_fn(method_name)
            attr = restricted_loads(await request.body())"""

    new_simple = """        @app.post("/simple_execute/{method_name}")
        async def execute_method(request: Request, method_name: str = Path(...)):
            self.check_nonce(request)
            method = self.get_fn(method_name)
            attr = restricted_loads(await request.body())
            self.check_lock()"""

    if old_simple in content:
        content = content.replace(old_simple, new_simple)
        print("  - simple_execute lock: Patched successfully.")
    else:
        print("  - simple_execute lock: Already patched or not matched.")
        
    # Patch execute lock (move check_lock below restricted_loads)
    old_exec = """        @app.post("/execute/{method_name}")
        async def execute_method(request: Request, method_name: str = Path(...)):
            self.check_nonce(request)
            self.check_lock()
            method = self.get_fn(method_name)
            attr = restricted_loads(await request.body())"""

    new_exec = """        @app.post("/execute/{method_name}")
        async def execute_method(request: Request, method_name: str = Path(...)):
            self.check_nonce(request)
            method = self.get_fn(method_name)
            attr = restricted_loads(await request.body())
            self.check_lock()"""

    if old_exec in content:
        content = content.replace(old_exec, new_exec)
        print("  - execute lock: Patched successfully.")
    else:
        print("  - execute lock: Already patched or not matched.")
        
    with open(share_path, "w", encoding="utf-8") as f:
        f.write(content)
        
    # Patch generic.py to close requests session (releases lock on Windows)
    generic_path = os.path.join(root_dir, "engine", "manga-image-translator", "manga_translator", "utils", "generic.py")
    if os.path.exists(generic_path):
        print(f"Patching {generic_path} for Windows file locks...")
        with open(generic_path, "r", encoding="utf-8") as f:
            gen_content = f.read()
            
        old_download = """    r = requests.get(url, stream=True, allow_redirects=True, headers=headers)
    if downloaded_size and r.headers.get('Accept-Ranges') != 'bytes':
        print('Error: Webserver does not support partial downloads. Restarting from the beginning.')
        r = requests.get(url, stream=True, allow_redirects=True)
        downloaded_size = 0
    total = int(r.headers.get('content-length', 0))
    chunk_size = 1024

    if r.ok:
        with tqdm.tqdm(
            desc=os.path.basename(path),
            initial=downloaded_size,
            total=total+downloaded_size,
            unit='iB',
            unit_scale=True,
            unit_divisor=chunk_size,
        ) as bar:
            with open(path, 'ab' if downloaded_size else 'wb') as f:
                is_tty = sys.stdout.isatty()
                downloaded_chunks = 0
                for data in r.iter_content(chunk_size=chunk_size):
                    size = f.write(data)
                    bar.update(size)

                    # Fallback for non TTYs so output still shown
                    downloaded_chunks += 1
                    if not is_tty and downloaded_chunks % 1000 == 0:
                        print(bar)
    else:
        raise Exception(f'Couldn\'t resolve url: "{url}" (Error: {r.status_code})')"""

        new_download = """    r = requests.get(url, stream=True, allow_redirects=True, headers=headers)
    try:
        if downloaded_size and r.headers.get('Accept-Ranges') != 'bytes':
            print('Error: Webserver does not support partial downloads. Restarting from the beginning.')
            r.close()
            r = requests.get(url, stream=True, allow_redirects=True)
            downloaded_size = 0
        total = int(r.headers.get('content-length', 0))
        chunk_size = 1024

        if r.ok:
            with tqdm.tqdm(
                desc=os.path.basename(path),
                initial=downloaded_size,
                total=total+downloaded_size,
                unit='iB',
                unit_scale=True,
                unit_divisor=chunk_size,
            ) as bar:
                with open(path, 'ab' if downloaded_size else 'wb') as f:
                    is_tty = sys.stdout.isatty()
                    downloaded_chunks = 0
                    for data in r.iter_content(chunk_size=chunk_size):
                        size = f.write(data)
                        bar.update(size)

                        # Fallback for non TTYs so output still shown
                        downloaded_chunks += 1
                        if not is_tty and downloaded_chunks % 1000 == 0:
                            print(bar)
        else:
            raise Exception(f'Couldn\'t resolve url: "{url}" (Error: {r.status_code})')
    finally:
        r.close()"""

        if old_download in gen_content:
            gen_content = gen_content.replace(old_download, new_download)
            with open(generic_path, "w", encoding="utf-8") as f:
                f.write(gen_content)
            print("  - generic.py: Patched successfully.")
        else:
            print("  - generic.py: Already patched or not matched.")

    # 2. Add engine path to sys.path to prepare models
    engine_root = os.path.join(root_dir, "engine", "manga-image-translator")
    sys.path.insert(0, engine_root)
    
    # Configure local cache directories in environments
    runtime_root = os.path.join(root_dir, "runtime")
    os.environ["TORCH_HOME"] = os.path.join(runtime_root, "torch-home")
    os.environ["HF_HOME"] = os.path.join(runtime_root, "hf-home")
    os.environ["XDG_CACHE_HOME"] = os.path.join(runtime_root, "xdg-cache")
    
    print("Downloading OCR and Detection models...")
    try:
        import asyncio
        from manga_translator.config import Detector, Ocr
        from manga_translator.detection import prepare as prepare_detector
        from manga_translator.ocr import prepare as prepare_ocr
        
        async def download_all():
            print("  - Preparing Default Detector...")
            await prepare_detector(Detector.default)
            print("  - Preparing 48px OCR Model...")
            await prepare_ocr(Ocr.ocr48px)
            print("  - Preparing Manga OCR (mocr) Model...")
            await prepare_ocr(Ocr.mocr)
            
        asyncio.run(download_all())
        print("All models prepared successfully!")
    except Exception as e:
        print(f"[WARNING] Model download failed or partially failed: {e}")
        print("Models will be downloaded automatically on first translation run if needed.")
        
    # 3. Download Fonts
    font_dir = os.path.join(root_dir, "data", "fonts")
    if not os.path.exists(font_dir):
        os.makedirs(font_dir)
        
    def download_file(url, dest):
        if not os.path.exists(dest):
            print(f"Downloading {os.path.basename(dest)}...")
            try:
                urllib.request.urlretrieve(url, dest)
                print(f"  - {os.path.basename(dest)} downloaded successfully.")
            except Exception as ex:
                print(f"  - Failed to download {os.path.basename(dest)}: {ex}")
        else:
            print(f"  - {os.path.basename(dest)} already exists.")
            
    kanit_bold_url = "https://github.com/google/fonts/raw/main/ofl/kanit/Kanit-Bold.ttf"
    kanit_reg_url = "https://github.com/google/fonts/raw/main/ofl/kanit/Kanit-Regular.ttf"
    
    download_file(kanit_bold_url, os.path.join(font_dir, "Kanit-Bold.ttf"))
    download_file(kanit_reg_url, os.path.join(font_dir, "Kanit-Regular.ttf"))
    
    # Create fonts README.md
    with open(os.path.join(font_dir, "README.md"), "w", encoding="utf-8") as rf:
        rf.write("# Fonts Directory\nPlace your custom Thai .ttf or .otf fonts here to use them in ScanLate.\n")

if __name__ == "__main__":
    main()
