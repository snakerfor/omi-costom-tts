import hashlib
import json
import os
import sys
import tempfile
import shutil
from pathlib import Path
from typing import Optional


def fallback_embedding(seed: str):
    digest = hashlib.sha256(seed.encode('utf-8')).digest()
    out = []
    for i in range(32):
        byte = digest[i % len(digest)]
        out.append((byte / 255.0) * 2 - 1)
    return out


def prepare_local_model_source(model_dir: str) -> Path:
    model_path = Path(model_dir)
    hyperparams_path = model_path / "hyperparams.yaml"
    if not hyperparams_path.exists():
        raise FileNotFoundError(f"missing hyperparams.yaml in {model_dir}")

    temp_dir = Path(tempfile.mkdtemp(prefix="speechbrain_local_model_"))
    for item in model_path.iterdir():
        target = temp_dir / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)

    raw = (temp_dir / "hyperparams.yaml").read_text(encoding="utf-8")
    rewritten = raw.replace(
        "pretrained_path: speechbrain/spkrec-ecapa-voxceleb",
        f"pretrained_path: {model_path}",
    )
    (temp_dir / "hyperparams.yaml").write_text(rewritten, encoding="utf-8")
    return temp_dir


def main():
    audio_paths = [p for p in sys.argv[1:] if p]
    if not audio_paths:
        print(json.dumps({"error": "no_audio_paths"}))
        return

    temp_model_dir: Optional[Path] = None
    try:
        import torch
        import soundfile as sf
        from scipy.signal import resample_poly
        from speechbrain.inference.speaker import EncoderClassifier

        model_dir = os.environ.get("SPEAKER_EMBEDDING_MODEL_DIR", "").strip()
        source = "speechbrain/spkrec-ecapa-voxceleb"
        savedir = "pretrained_models/spkrec-ecapa-voxceleb"
        if model_dir:
            temp_model_dir = prepare_local_model_source(model_dir)
            source = str(temp_model_dir)
            savedir = source

        classifier = EncoderClassifier.from_hparams(
            source=source,
            savedir=savedir,
        )

        embs = []
        for p in audio_paths:
            if not Path(p).exists():
                continue

            waveform, sample_rate = sf.read(p, always_2d=True)
            waveform = waveform.mean(axis=1)
            if sample_rate != 16000:
                waveform = resample_poly(waveform, 16000, sample_rate)
            waveform = torch.tensor(waveform, dtype=torch.float32).unsqueeze(0)

            with torch.no_grad():
                emb = classifier.encode_batch(waveform).squeeze().cpu()
            embs.append(emb)

        if not embs:
            print(json.dumps({"error": "no_valid_audio"}))
            return

        agg = torch.stack(embs, dim=0).mean(dim=0)
        print(json.dumps({"embedding": agg.tolist()}))
        return
    except Exception as exc:
        # fallback: 允许未安装依赖时仍可跑通流程
        file_hashes = []
        for p in audio_paths:
            try:
                file_hashes.append(hashlib.sha256(Path(p).read_bytes()).hexdigest())
            except Exception:
                file_hashes.append(p)
        seed = "|".join(file_hashes)
        print(json.dumps({
            "embedding": fallback_embedding(seed),
            "fallback": True,
            "fallback_reason": str(exc),
        }))
    finally:
        if temp_model_dir is not None:
            shutil.rmtree(temp_model_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
