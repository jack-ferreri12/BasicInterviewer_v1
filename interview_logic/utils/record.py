import sounddevice as sd
import numpy as np
import tempfile
import scipy.io.wavfile

def record_until_silence(samplerate=16000, silence_threshold=100, silence_duration=1.5):
    block_size = int(0.1 * samplerate)
    silence_blocks = int(silence_duration / 0.1)
    audio_frames = []
    silent_counter = 0

    print("[Recording] Speak now...")

    with sd.InputStream(samplerate=samplerate, channels=1, dtype='int16') as stream:
        while True:
            block, _ = stream.read(block_size)
            audio_frames.append(block)
            volume = np.abs(block).mean()

            if volume < silence_threshold:
                silent_counter += 1
            else:
                silent_counter = 0

            if silent_counter >= silence_blocks:
                break

    audio = np.concatenate(audio_frames, axis=0)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmpfile:
        scipy.io.wavfile.write(tmpfile.name, samplerate, audio)
        return tmpfile.name  # temp file path to delete after use
