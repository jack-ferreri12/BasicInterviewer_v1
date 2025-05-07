import asyncio
import tempfile
import simpleaudio as sa
from pydub import AudioSegment
import edge_tts
import os

class EdgeTTS:
    def __init__(self, voice="en-US-AriaNeural"):
        self.voice = voice

    async def speak(self, text):
        try:
            communicate = edge_tts.Communicate(text, voice=self.voice)
            # Create a temporary MP3 file to hold the audio data
            with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as mp3_tmp:
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        mp3_tmp.write(chunk["data"])
                mp3_path = mp3_tmp.name

            # Convert the MP3 file to WAV format
            wav_path = mp3_path.replace(".mp3", ".wav")
            AudioSegment.from_file(mp3_path).export(wav_path, format="wav")

            # Play the WAV file using simpleaudio
            wave_obj = sa.WaveObject.from_wave_file(wav_path)
            play_obj = wave_obj.play()
            play_obj.wait_done()  # Wait for the audio to finish

        except Exception as e:
            print(f"[Error] TTS playback failed: {e}")
        finally:
            # Cleanup temporary files
            try:
                os.remove(mp3_path)
                os.remove(wav_path)
            except Exception as e:
                print(f"[Error] Failed to clean up temporary files: {e}")

# Example usage
async def main():
    tts = EdgeTTS()
    await tts.speak("Hello, welcome to this interview!")

# To run the function
if __name__ == "__main__":
    asyncio.run(main())
