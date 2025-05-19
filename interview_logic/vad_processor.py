import webrtcvad
import wave
import os
import tempfile
import time
import csv
import re
from collections import deque
import uuid

class RealtimeVADProcessor:
    def __init__(self, 
                 rate=16000, 
                 frame_duration_ms=20,  # webrtcvad supports 10, 20, 30 ms
                 channels=1, 
                 sample_width=2, # paInt16 -> 2 bytes
                 aggressiveness=3,
                 initial_idle_time_ms=3000, # Adapted from INITIAL_IDLE_TIME
                 subsequent_idle_time_ms=2500, # Changed from 1500
                 min_speech_duration_ms=300, # Changed from 200
                 log_directory="logs"):

        self.rate = rate
        self.frame_duration_ms = frame_duration_ms
        self.channels = channels
        self.sample_width = sample_width # Bytes per sample
        self.aggressiveness = aggressiveness
        self.vad = webrtcvad.Vad(aggressiveness)

        self.samples_per_frame = int(self.rate * (self.frame_duration_ms / 1000.0))
        self.bytes_per_frame = self.samples_per_frame * self.channels * self.sample_width

        self.initial_idle_time_ms = initial_idle_time_ms
        self.subsequent_idle_time_ms = subsequent_idle_time_ms
        self.current_max_idle_ms = self.initial_idle_time_ms
        
        self.min_speech_frames = min_speech_duration_ms // self.frame_duration_ms

        self.log_directory = log_directory
        os.makedirs(self.log_directory, exist_ok=True)

        self._reset_utterance_state()

    def _reset_utterance_state(self):
        self.buffered_frames = deque()
        self.vad_data_chars = []
        self.current_silence_ms = 0
        self.user_has_started_speaking_this_turn = False
        self.utterance_finalized = False
        self.active_speech_frames_in_utterance = 0
        print("VAD Processor: State reset for new utterance.")

    def process_audio_chunk(self, chunk_bytes):
        """
        Processes an incoming audio chunk.
        Returns True if an utterance has been finalized, False otherwise.
        """
        if self.utterance_finalized:
            # If called after finalization, typically means we should reset for a new utterance.
            # However, the caller (WebSocket handler) should manage when to reset explicitly.
            print("VAD Processor: Process called on finalized utterance. Ignoring chunk.")
            return False

        if len(chunk_bytes) != self.bytes_per_frame:
            print(f"VAD Processor: Warning - received chunk of size {len(chunk_bytes)}, expected {self.bytes_per_frame}. Skipping.")
            # In a robust implementation, we might buffer partial chunks. For now, skip.
            return False

        try:
            is_speech = self.vad.is_speech(chunk_bytes, self.rate)
        except webrtcvad.Error as e:
            print(f"VAD Processor: WebRTCVAD error: {e}. Assuming non-speech.")
            is_speech = False
        
        self.vad_data_chars.append('1' if is_speech else '_')
        self.buffered_frames.append(chunk_bytes)

        if is_speech:
            self.active_speech_frames_in_utterance +=1
            self.current_silence_ms = 0
            if not self.user_has_started_speaking_this_turn:
                self.user_has_started_speaking_this_turn = True
                self.current_max_idle_ms = self.subsequent_idle_time_ms
                print(f"VAD Processor: Speech started, idle time set to {self.current_max_idle_ms}ms")
        else: # Silence
            if self.user_has_started_speaking_this_turn: # Only count silence if user has already spoken
                self.current_silence_ms += self.frame_duration_ms
            elif not self.user_has_started_speaking_this_turn and len(self.buffered_frames) * self.frame_duration_ms > self.initial_idle_time_ms:
                # User hasn't spoken, and initial idle time exceeded with silence.
                # This means we are likely picking up just noise. Reset buffer to avoid long silent recordings.
                # This helps against "slightest noise still causes the STT to detect the user as 'recording'"
                # if that noise doesn't lead to actual speech within initial_idle_time_ms.
                print(f"VAD Processor: Initial idle time ({self.initial_idle_time_ms}ms) exceeded with silence. Clearing buffer.")
                self.buffered_frames.clear()
                self.vad_data_chars.clear() 
                # Keep user_has_started_speaking_this_turn = False
                # Keep current_max_idle_ms = self.initial_idle_time_ms
                return False


        if self.user_has_started_speaking_this_turn and self.current_silence_ms >= self.current_max_idle_ms:
            print(f"VAD Processor: Utterance ended. Silence ({self.current_silence_ms}ms) >= idle time ({self.current_max_idle_ms}ms)")
            self.utterance_finalized = True
            return True
        
        return False

    def get_finalized_utterance(self):
        """
        Should be called when process_audio_chunk returns True or stream ends.
        Returns (path_to_audio_file, vad_data_string) or (None, "") if not enough speech.
        """
        if not self.utterance_finalized and not self.user_has_started_speaking_this_turn :
             # Stream might have ended before any speech or before finalization due to timeout
            print("VAD Processor: Get finalized called, but no speech detected or utterance not finalized by silence.")
            if not self.buffered_frames or self.active_speech_frames_in_utterance < self.min_speech_frames:
                 self._reset_utterance_state() # Ensure clean state for next time
                 return None, ""
        
        # Trim trailing silence that caused finalization
        num_silence_frames_to_trim = self.current_max_idle_ms // self.frame_duration_ms
        
        final_frames_for_audio = list(self.buffered_frames)
        final_vad_chars_for_audio = list(self.vad_data_chars)

        if self.user_has_started_speaking_this_turn : # Only trim if speech actually happened
            # Ensure we don't trim more frames than available or into actual speech
            effective_trim_count = 0
            temp_trimmed_vad = []
            
            # Identify how many actual trailing silence frames there are up to num_silence_frames_to_trim
            # We need to look from the end of vad_data_chars
            trailing_silence_count = 0
            for char_idx in range(len(self.vad_data_chars) -1, -1, -1):
                if self.vad_data_chars[char_idx] == '_':
                    trailing_silence_count +=1
                else:
                    break # Hit speech
                if trailing_silence_count >= num_silence_frames_to_trim:
                    break
            
            # The actual frames to keep are all frames minus these identified trailing silences
            # (if they indeed led to finalization)
            
            # A simpler trim: find last speech frame and take up to that.
            # This is from vad-stt-chatbot 'calculate_and_display_speech_metrics' for 'vad_string_for_metrics'
            
            full_vad_string = "".join(self.vad_data_chars)
            first_speech_idx_in_vad = full_vad_string.find('1')
            last_speech_idx_in_vad = full_vad_string.rfind('1')

            if first_speech_idx_in_vad == -1 or (last_speech_idx_in_vad - first_speech_idx_in_vad +1) < self.min_speech_frames :
                print(f"VAD Processor: Not enough speech frames ({self.active_speech_frames_in_utterance} active, needed {self.min_speech_frames} in VAD string segment). Discarding.")
                self._reset_utterance_state()
                return None, full_vad_string # Return full VAD string for potential logging of empty attempt
            
            # Extract frames from first speech to last speech detected in the VAD string.
            # This provides a tight crop around speech.
            audio_data_to_save = bytearray()
            # We need to iterate through buffered_frames and original vad_data_chars to pick the right ones
            
            frames_to_consider_for_saving = list(self.buffered_frames)
            vad_chars_for_these_frames = list(self.vad_data_chars)

            # Ensure indices align
            start_frame_index = first_speech_idx_in_vad 
            end_frame_index = last_speech_idx_in_vad + 1 # Slice goes up to, but not including, end

            if start_frame_index < len(frames_to_consider_for_saving) and end_frame_index <= len(frames_to_consider_for_saving):
                for i in range(start_frame_index, end_frame_index):
                    audio_data_to_save.extend(frames_to_consider_for_saving[i])
            else: # Should not happen if logic is correct
                print("VAD Processor: Mismatch in VAD string indices and frame buffer length during finalization.")
                # Fallback to taking all buffered frames if speech was detected.
                if self.active_speech_frames_in_utterance >= self.min_speech_frames:
                    for frame_bytes in self.buffered_frames:
                        audio_data_to_save.extend(frame_bytes)
                else:
                    self._reset_utterance_state()
                    return None, full_vad_string


            if not audio_data_to_save: # Should be caught by min_speech_frames check earlier
                 print("VAD Processor: No audio data to save after attempting to trim.")
                 self._reset_utterance_state()
                 return None, full_vad_string


            # Save to temp file
            temp_audio_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav", dir=self.log_directory) # Save in logs for easier debugging if needed
            temp_audio_file_path = temp_audio_file.name
            temp_audio_file.close() # Close to allow wave.open to write

            with wave.open(temp_audio_file_path, 'wb') as wf:
                wf.setnchannels(self.channels)
                wf.setsampwidth(self.sample_width)
                wf.setframerate(self.rate)
                wf.writeframes(audio_data_to_save)
            
            print(f"VAD Processor: Finalized audio saved to {temp_audio_file_path}")
            
            # Keep the full VAD string for comprehensive metrics, reset state for next one
            final_vad_str = "".join(self.vad_data_chars)
            self._reset_utterance_state() 
            return temp_audio_file_path, final_vad_str

        else: # No speech started, or not finalized by silence timeout (e.g. stream just ended)
            print("VAD Processor: Get finalized utterance - no speech started or not finalized by silence.")
            full_vad_string = "".join(self.vad_data_chars) # Could be all silence
            if self.active_speech_frames_in_utterance < self.min_speech_frames :
                print(f"VAD Processor: Not enough speech frames ({self.active_speech_frames_in_utterance}). Discarding.")
                self._reset_utterance_state()
                return None, full_vad_string
            else: # Some speech but not finalized by silence (e.g. abrupt stream cut)
                  # Save what we have if it meets min length
                audio_data_to_save = bytearray()
                for frame_bytes in self.buffered_frames: # Save everything buffered
                    audio_data_to_save.extend(frame_bytes)
                
                if not audio_data_to_save:
                    self._reset_utterance_state()
                    return None, full_vad_string

                temp_audio_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav", dir=self.log_directory)
                temp_audio_file_path = temp_audio_file.name
                temp_audio_file.close()
                with wave.open(temp_audio_file_path, 'wb') as wf:
                    wf.setnchannels(self.channels)
                    wf.setsampwidth(self.sample_width)
                    wf.setframerate(self.rate)
                    wf.writeframes(audio_data_to_save)
                print(f"VAD Processor: Finalized audio (stream ended) saved to {temp_audio_file_path}")
                final_vad_str = "".join(self.vad_data_chars)
                self._reset_utterance_state()
                return temp_audio_file_path, final_vad_str


    def log_speech_metrics(self, original_vad_string, transcribed_text, audio_filename_for_log):
        # Adapted from vad-stt-chatbot.py's calculate_and_display_speech_metrics
        # audio_filename_for_log should be the unique name of the saved audio segment.
        
        log_file_path = os.path.join(self.log_directory, "speech_metrics.csv")
        timestamp = time.time()
        unique_id = str(uuid.uuid4())

        # Default metrics for cases with no VAD string or no speech
        metrics_data = {
            "uuid": unique_id, "timestamp": timestamp, "audio_filename": audio_filename_for_log,
            "original_vad_string": original_vad_string if original_vad_string else "",
            "trimmed_vad_string_for_metrics": "", "total_active_duration_seconds": 0,
            "speech_time_seconds": 0, "internal_pause_time_seconds": 0, "num_internal_pauses": 0,
            "avg_internal_pause_duration_seconds": 0, 
            "word_count": len(transcribed_text.split()) if transcribed_text else 0,
            "characters_spoken_count": len(transcribed_text) if transcribed_text else 0, 
            "wpm_total_active": 0, "wpm_speaking": 0, "cps_speaking": 0,
            "transcribed_text": transcribed_text if transcribed_text else ""
        }

        if original_vad_string:
            first_speech_idx = original_vad_string.find('1')
            last_speech_idx = original_vad_string.rfind('1')
            vad_string_for_metrics = ""

            if first_speech_idx != -1:
                vad_string_for_metrics = original_vad_string[first_speech_idx : last_speech_idx + 1]
            
            if vad_string_for_metrics: # Only calculate if there's a valid segment
                time_per_char_seconds = self.frame_duration_ms / 1000.0

                total_duration_seconds = len(vad_string_for_metrics) * time_per_char_seconds
                speech_chars_count = vad_string_for_metrics.count('1')
                speech_time_seconds = speech_chars_count * time_per_char_seconds
                pause_chars_count = vad_string_for_metrics.count('_')
                pause_time_seconds = pause_chars_count * time_per_char_seconds

                num_pauses = len(re.findall(r'_+', vad_string_for_metrics))
                avg_pause_duration_seconds = (pause_time_seconds / num_pauses) if num_pauses > 0 else 0
                
                word_count = len(transcribed_text.split()) if transcribed_text else 0
                characters_spoken_count = len(transcribed_text) if transcribed_text else 0

                speech_time_minutes_wpm_speaking = speech_time_seconds / 60.0
                wpm_speaking = (word_count / speech_time_minutes_wpm_speaking) if speech_time_minutes_wpm_speaking > 0 else 0
                
                total_duration_minutes_wpm_total = total_duration_seconds / 60.0
                wpm_total = (word_count / total_duration_minutes_wpm_total) if total_duration_minutes_wpm_total > 0 else 0
                
                cps_speaking = (characters_spoken_count / speech_time_seconds) if speech_time_seconds > 0 else 0

                metrics_data.update({
                    "trimmed_vad_string_for_metrics": vad_string_for_metrics,
                    "total_active_duration_seconds": round(total_duration_seconds, 2),
                    "speech_time_seconds": round(speech_time_seconds, 2),
                    "internal_pause_time_seconds": round(pause_time_seconds, 2),
                    "num_internal_pauses": num_pauses,
                    "avg_internal_pause_duration_seconds": round(avg_pause_duration_seconds, 2),
                    "wpm_total_active": round(wpm_total, 2),
                    "wpm_speaking": round(wpm_speaking, 2),
                    "cps_speaking": round(cps_speaking, 2)
                })
        
        fieldnames = [
            "uuid", "timestamp", "audio_filename", "original_vad_string", "trimmed_vad_string_for_metrics",
            "total_active_duration_seconds", "speech_time_seconds", "internal_pause_time_seconds",
            "num_internal_pauses", "avg_internal_pause_duration_seconds", "word_count",
            "characters_spoken_count", "wpm_total_active", "wpm_speaking", "cps_speaking",
            "transcribed_text"
        ]
        
        file_exists = os.path.isfile(log_file_path)
        try:
            with open(log_file_path, mode='a', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                if not file_exists:
                    writer.writeheader()
                writer.writerow(metrics_data)
            print(f"VAD Processor: Speech metrics logged to {log_file_path} with UUID {unique_id}")
        except IOError as e:
            print(f"VAD Processor: Error writing metrics to {log_file_path}: {e}")
        
        return unique_id # Return UUID for reference if needed 