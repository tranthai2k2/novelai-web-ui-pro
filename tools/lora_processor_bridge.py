import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path


def sanitize_filename(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]+', "_", value).strip()
    return cleaned[:120] or "character"


def load_module(module_path: Path):
    spec = importlib.util.spec_from_file_location("external_lora_processor", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module from {module_path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    if len(sys.argv) != 6:
      raise SystemExit("Usage: lora_processor_bridge.py <processor_path> <folder_path> <character_name> <character_prompt> <temp_output_dir>")

    processor_path = Path(sys.argv[1]).expanduser()
    folder_path = Path(sys.argv[2]).expanduser()
    character_name = sys.argv[3].strip()
    character_prompt = sys.argv[4].strip()
    temp_output_dir = Path(sys.argv[5]).expanduser()

    if not processor_path.exists():
        raise FileNotFoundError(f"Processor not found: {processor_path}")
    if not folder_path.exists():
        raise FileNotFoundError(f"Folder not found: {folder_path}")
    if not character_prompt:
        raise ValueError("Character prompt is empty")

    processor = load_module(processor_path)

    ok, message = processor.run_tag_enhancer(folder_path)
    if not ok:
        raise RuntimeError(f"run_tag_enhancer failed: {message}")

    ok, message, char_file = processor.process_character_txt(folder_path, character_prompt)
    if not ok or char_file is None:
        raise RuntimeError(f"process_character_txt failed: {message}")

    char_file = Path(char_file)
    temp_output_dir.mkdir(parents=True, exist_ok=True)

    temp_name = sanitize_filename(character_name or "character")
    copied_path = temp_output_dir / f"{temp_name}.txt"
    shutil.copyfile(char_file, copied_path)

    prompts = [
        line.strip()
        for line in copied_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    print(json.dumps({
        "message": message,
        "characterFile": str(char_file),
        "tempFile": str(copied_path),
        "prompts": prompts,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
