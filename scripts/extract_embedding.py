import hashlib
import json
import sys
from pathlib import Path


def fallback_embedding(seed: str):
    digest = hashlib.sha256(seed.encode('utf-8')).digest()
    out = []
    for i in range(32):
        byte = digest[i % len(digest)]
        out.append((byte / 255.0) * 2 - 1)
    return out


def main():
    audio_paths = [p for p in sys.argv[1:] if p]
    if not audio_paths:
        print(json.dumps({"error": "no_audio_paths"}))
        return

    try:
        import torch
        import torchaudio
        from speechbrain.inference.speaker import EncoderClassifier

        classifier = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir="pretrained_models/spkrec-ecapa-voxceleb",
        )

        embs = []
        for p in audio_paths:
            if not Path(p).exists():
                continue

            waveform, sample_rate = torchaudio.load(p)
            if waveform.shape[0] > 1:
                waveform = waveform.mean(dim=0, keepdim=True)
            if sample_rate != 16000:
                waveform = torchaudio.functional.resample(waveform, sample_rate, 16000)

            with torch.no_grad():
                emb = classifier.encode_batch(waveform).squeeze().cpu()
            embs.append(emb)

        if not embs:
            print(json.dumps({"error": "no_valid_audio"}))
            return

        agg = torch.stack(embs, dim=0).mean(dim=0)
        print(json.dumps({"embedding": agg.tolist()}))
        return
    except Exception:
        # fallback: 允许未安装依赖时仍可跑通流程
        file_hashes = []
        for p in audio_paths:
            try:
                file_hashes.append(hashlib.sha256(Path(p).read_bytes()).hexdigest())
            except Exception:
                file_hashes.append(p)
        seed = "|".join(file_hashes)
        print(json.dumps({"embedding": fallback_embedding(seed), "fallback": True}))


if __name__ == "__main__":
    main()
