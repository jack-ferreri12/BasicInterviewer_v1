import simpleaudio as sa

def play_audio(filename: str):
    try:
        wave_obj = sa.WaveObject.from_wave_file(filename)
        play_obj = wave_obj.play()
        play_obj.wait_done()
    except Exception as e:
        print(f"[Error playing {filename}]:", e)
