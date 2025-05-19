import asyncio
import tempfile
import simpleaudio as sa
from pydub import AudioSegment
import edge_tts
import os

class EdgeTTS:
    def __init__(self, voice="en-US-AriaNeural"):
        self.voice = voice

    async def speak(self, text, output_filename=None):
        """ 
        Generates speech from text.
        If output_filename is provided, saves to file and returns True/False.
        If output_filename is None, plays audio on server and returns True/False (or None on exception).
        """
        mp3_path_temp = None # Temporary MP3 path
        wav_path_temp = None # Temporary WAV path (if playing on server)
        final_output_path = None # Could be mp3 or wav depending on what client expects

        try:
            communicate = edge_tts.Communicate(text, voice=self.voice)
            
            # Use a temporary file for initial MP3 data from edge-tts
            # We need to decide if the final output_filename is MP3 or WAV.
            # Let's assume client can handle MP3 directly for simplicity and to avoid conversion if not needed.

            if output_filename:
                # Client wants a file. Ensure directory exists.
                os.makedirs(os.path.dirname(output_filename), exist_ok=True)
                final_output_path = output_filename # Client will receive this path
                with open(final_output_path, "wb") as f_out:
                    async for chunk in communicate.stream():
                        if chunk["type"] == "audio":
                            f_out.write(chunk["data"])
                print(f"[TTS Engine] Audio saved to: {final_output_path}")
                return True # Indicates success in saving file
            else:
                # Play on server (original behavior, but now with explicit return)
                # Create a temporary MP3 file to hold the audio data
                with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as mp3_tmp_file_obj:
                    async for chunk in communicate.stream():
                        if chunk["type"] == "audio":
                            mp3_tmp_file_obj.write(chunk["data"])
                    mp3_path_temp = mp3_tmp_file_obj.name

                # Convert the MP3 file to WAV format for simpleaudio
                wav_path_temp = mp3_path_temp.replace(".mp3", ".wav")
                AudioSegment.from_file(mp3_path_temp).export(wav_path_temp, format="wav")

                # Play the WAV file using simpleaudio
                wave_obj = sa.WaveObject.from_wave_file(wav_path_temp)
                play_obj = wave_obj.play()
                play_obj.wait_done()  # Wait for the audio to finish
                print(f"[TTS Engine] Audio played on server.")
                return True # Indicates success in playing on server

        except Exception as e:
            print(f"[Error] TTS processing failed: {e}")
            return False # Indicates failure
        finally:
            # Cleanup temporary files if they were created for server-side playback
            if mp3_path_temp and os.path.exists(mp3_path_temp):
                try:
                    os.remove(mp3_path_temp)
                except Exception as e_clean:
                    print(f"[Error] Failed to clean up temporary MP3 file {mp3_path_temp}: {e_clean}")
            if wav_path_temp and os.path.exists(wav_path_temp):
                try:
                    os.remove(wav_path_temp)
                except Exception as e_clean:
                    print(f"[Error] Failed to clean up temporary WAV file {wav_path_temp}: {e_clean}")
            # Note: If output_filename was provided, we do NOT clean it up here.
            # The caller (api.py) might manage its lifecycle or it's served statically.

# Example usage (remains the same, but behavior changes based on args to speak)
async def main():
    tts_engine = EdgeTTS()
    # Example 1: Play on server
    print("Playing on server...")
    await tts_engine.speak("Hello, this is a server-side playback test!")
    
    # Example 2: Save to file
    print("\nSaving to file...")
    save_path = "./test_tts_output.mp3"
    if await tts_engine.speak("Hello, this audio is saved to a file!", output_filename=save_path):
        print(f"Saved successfully to {save_path}")
    else:
        print(f"Failed to save to {save_path}")

if __name__ == "__main__":
    asyncio.run(main())
