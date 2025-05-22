import asyncio
import tempfile
import simpleaudio as sa
from pydub import AudioSegment
import edge_tts
import os
import traceback
import time

class EdgeTTS:
    def __init__(self, voice="en-US-AriaNeural"):
        self.voice = voice
        # Backup voices in case the primary fails
        self.backup_voices = [
            "en-US-GuyNeural",
            "en-US-JennyNeural",
            "en-GB-SoniaNeural"
        ]
        self.last_request_time = 0
        self.request_counter = 0

    async def speak(self, text, output_filename=None):
        """ 
        Generates speech from text.
        If output_filename is provided, saves to file and returns True/False.
        If output_filename is None, plays audio on server and returns True/False (or None on exception).
        """
        mp3_path_temp = None # Temporary MP3 path
        wav_path_temp = None # Temporary WAV path (if playing on server)
        final_output_path = None # Could be mp3 or wav depending on what client expects
        
        # Rate limit check - ensure requests are spaced at least 500ms apart
        current_time = time.time()
        time_since_last = current_time - self.last_request_time
        if time_since_last < 0.5:  # If less than 500ms since last request
            await asyncio.sleep(0.5 - time_since_last)  # Wait the remaining time
        
        self.last_request_time = time.time()
        self.request_counter += 1
        request_id = self.request_counter
        
        print(f"[TTS Engine #{request_id}] Starting TTS generation for text ({len(text)} chars): '{text[:50]}...'")
        
        # Implement circuit breaker pattern with multiple voices
        voices_to_try = [self.voice] + self.backup_voices
        last_exception = None
        
        try:
            for voice_attempt, current_voice in enumerate(voices_to_try):
                try:
                    communicate = edge_tts.Communicate(text, voice=current_voice)
                    
                    if output_filename:
                        # Client wants a file. Ensure directory exists.
                        os.makedirs(os.path.dirname(output_filename), exist_ok=True)
                        final_output_path = output_filename # Client will receive this path
                        
                        # Write to a temporary file first, then rename
                        temp_output = f"{output_filename}.temp"
                        
                        with open(temp_output, "wb") as f_out:
                            try:
                                chunk_count = 0
                                total_bytes = 0
                                async for chunk in communicate.stream():
                                    if chunk["type"] == "audio":
                                        f_out.write(chunk["data"])
                                        chunk_count += 1
                                        total_bytes += len(chunk["data"])
                                        
                            except Exception as stream_error:
                                print(f"[TTS Engine #{request_id}] Error during streaming with voice {current_voice}: {stream_error}")
                                traceback.print_exc()
                                raise
                        
                        # Verify file size
                        if total_bytes == 0 or chunk_count == 0:
                            raise ValueError(f"TTS produced empty output (0 bytes, 0 chunks) for voice {current_voice}")
                        
                        print(f"[TTS Engine #{request_id}] Generated audio: {chunk_count} chunks, {total_bytes} bytes, using voice {current_voice}")
                        
                        # If successful, rename the temporary file to the final filename
                        if os.path.exists(temp_output) and os.path.getsize(temp_output) > 0:
                            # On Windows, we need to remove the destination file first
                            if os.path.exists(final_output_path):
                                os.remove(final_output_path)
                            os.rename(temp_output, final_output_path)
                            print(f"[TTS Engine #{request_id}] Audio saved to: {final_output_path} ({os.path.getsize(final_output_path)} bytes)")
                            return True
                        else:
                            raise ValueError(f"Temporary TTS file is empty or missing: {temp_output}")
                            
                    else:
                        # Play on server (original behavior, but now with explicit return)
                        # Create a temporary MP3 file to hold the audio data
                        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as mp3_tmp_file_obj:
                            async for chunk in communicate.stream():
                                if chunk["type"] == "audio":
                                    mp3_tmp_file_obj.write(chunk["data"])
                            mp3_path_temp = mp3_tmp_file_obj.name

                        # Verify the file was created and has content
                        if not os.path.exists(mp3_path_temp) or os.path.getsize(mp3_path_temp) == 0:
                            raise ValueError(f"TTS produced empty output file: {mp3_path_temp}")

                        # Convert the MP3 file to WAV format for simpleaudio
                        wav_path_temp = mp3_path_temp.replace(".mp3", ".wav")
                        AudioSegment.from_file(mp3_path_temp).export(wav_path_temp, format="wav")

                        # Play the WAV file using simpleaudio
                        wave_obj = sa.WaveObject.from_wave_file(wav_path_temp)
                        play_obj = wave_obj.play()
                        play_obj.wait_done()  # Wait for the audio to finish
                        print(f"[TTS Engine #{request_id}] Audio played on server.")
                        return True # Indicates success in playing on server
                    
                    # If we reach here without returning, something unexpected happened
                    raise ValueError("TTS completed without returning a result")
                    
                except Exception as e:
                    print(f"[TTS Engine #{request_id}] Error with voice {current_voice} (attempt {voice_attempt+1}/{len(voices_to_try)}): {str(e)}")
                    traceback.print_exc()
                    last_exception = e
                    
                    # Try to clean up any partial temp file
                    if output_filename:
                        temp_output = f"{output_filename}.temp"
                        if os.path.exists(temp_output):
                            try:
                                os.remove(temp_output)
                                print(f"[TTS Engine #{request_id}] Removed incomplete temp file: {temp_output}")
                            except Exception as e_clean:
                                print(f"[TTS Engine #{request_id}] Failed to remove temp file {temp_output}: {e_clean}")
                    
                    # Continue to next voice if we have more to try
                    if voice_attempt < len(voices_to_try) - 1:
                        print(f"[TTS Engine #{request_id}] Trying next voice: {voices_to_try[voice_attempt+1]}")
                        await asyncio.sleep(0.5)  # Brief pause before trying next voice
                        continue
                    else:
                        print(f"[TTS Engine #{request_id}] All voices failed, giving up.")
                        return False
                        
            # If we reach here, all voice attempts failed
            print(f"[TTS Engine #{request_id}] TTS processing failed after trying {len(voices_to_try)} voices.")
            if last_exception:
                print(f"[TTS Engine #{request_id}] Last error: {last_exception}")
            return False
            
        finally:
            # Cleanup temporary files if they were created for server-side playback
            if mp3_path_temp and os.path.exists(mp3_path_temp):
                try:
                    os.remove(mp3_path_temp)
                except Exception as e_clean:
                    print(f"[TTS Engine #{request_id}] Failed to clean up temporary MP3 file {mp3_path_temp}: {e_clean}")
            if wav_path_temp and os.path.exists(wav_path_temp):
                try:
                    os.remove(wav_path_temp)
                except Exception as e_clean:
                    print(f"[TTS Engine #{request_id}] Failed to clean up temporary WAV file {wav_path_temp}: {e_clean}")
            
            if output_filename:
                temp_output = f"{output_filename}.temp"
                if os.path.exists(temp_output):
                    try:
                        os.remove(temp_output)
                    except Exception as e_clean:
                        print(f"[TTS Engine #{request_id}] Failed to clean up leftover temp file {temp_output}: {e_clean}")

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
