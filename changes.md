# VAD Integration and System Overhaul for BasicInterviewer

## 1. Original System Flow (High-Level)

The original system operated as follows:

1.  **Client-Side Recording**: The client (`app.js`) recorded audio, with some form of basic client-side silence detection (e.g., `recordAudioWithSilenceDetection`).
2.  **HTTP Audio Submission**: After recording, the client submitted the complete audio blob via an HTTP POST request to an endpoint like `/answer`.
3.  **Server-Side Processing**:
    - The server (`api.py`) received the audio file.
    - It transcribed the audio (e.g., using WhisperSTT).
    - It sent the transcript to an N8N webhook for AI processing (getting the AI's response/next question).
    - It performed Text-to-Speech (TTS) for the AI's response, with audio lplaying directly on the server.
4.  **Client-Side Update**: The client received a JSON response (including AI text) and updated the UI.

## 2. New System Flow (Detailed)

The new system implements a more interactive, real-time flow:

### 2.1. Initialization

1.  **Client (`app.js`)**:
    - User initiates an interview (e.g., selects mode, clicks "Start Interview").
    - Client may call `/start` (HTTP GET) on the server to initialize the interview session state (mode, questions).
    - Client calls `connectWebSocket()` to establish a WebSocket connection to the `/ws/interview_audio` endpoint on the server.
2.  **Server (`api.py` - `/ws/interview_audio`)**:
    - Accepts the WebSocket connection.
    - Sends an initial message to the client (e.g., `type: "interview_ready"`). This message can include:
      - The first question if available.
      - The total number of questions.
      - An action for the client (e.g., `action: "speak_and_listen"` or `action: "prompt_custom_question"`).

### 2.2. TTS and Listening Loop (Driven by Server Messages via WebSocket)

1.  **Client Receives Message (`socket.onmessage` in `app.js`)**:
    - Parses the JSON message from the server. This message might contain an AI response, the next question, an error, or status updates.
2.  **Client Performs TTS (`speakText` function in `app.js`)**:
    - If the server message includes text to be spoken (AI response or a question prompt):
      - The client calls its local `speakText(textToSpeak)` function.
      - `speakText` makes an HTTP POST request to `/speak_question` on the server, sending the `textToSpeak`.
3.  **Server Generates TTS Audio (`/speak_question` in `api.py`)**:
    - Receives the text from the client.
    - Uses the modified `EdgeTTS.speak(text, output_filename)` method to generate an MP3 audio file.
    - Saves this audio file to a static-served directory (e.g., `app/static/tts_audio/some_unique_name.mp3`).
    - Returns a JSON response to the client containing the `audio_url` (e.g., `/static/tts_audio/some_unique_name.mp3`).
4.  **Client Plays TTS Audio (`speakText` in `app.js`)**:
    - Receives the `audio_url` from the `/speak_question` response.
    - Creates an HTML `<audio>` element, sets its `src` to the `audio_url`, and plays it.
    - The `speakText` function returns a Promise that resolves when audio playback is complete.
5.  **Client Starts Audio Streaming (`startAudioStreaming` in `app.js`)**:
    - After the `speakText` Promise resolves (i.e., TTS playback finishes):
      - The client calls `startAudioStreaming()`.
      - This function uses `navigator.mediaDevices.getUserMedia()` to access the microphone.
      - It sets up an `AudioContext` and a `ScriptProcessorNode`.
      - The `onaudioprocess` event of the `ScriptProcessorNode` is used to:
        - Get raw audio data (Float32 PCM).
        - Convert it to 16-bit Integer PCM.
        - Buffer and send audio chunks of a specific size (e.g., 20ms duration, 640 bytes for 16kHz mono 16-bit) over the WebSocket to the server.
      - Sets `isStreamingAudio = true`.

### 2.3. Server-Side Audio Processing & VAD (`/ws/interview_audio` in `api.py`)

1.  **Receive Audio Chunks**: The WebSocket endpoint continuously receives binary audio chunks from the client.
2.  **Real-time VAD (`RealtimeVADProcessor` instance)**:
    - Each chunk is passed to `vad_processor.process_audio_chunk(data)`.
    - The VAD processor uses `webrtcvad` to classify each frame as speech or silence.
    - It manages buffering, accumulating speech segments, and tracking silence periods (pre-speech, mid-speech, post-speech).
    - Note: Detailed VAD metrics for an utterance are logged after it's finalized and transcribed (see next step).
3.  **Utterance Finalization**:
    - When the `RealtimeVADProcessor` determines an utterance has ended (based on configured silence duration):
      - It calls `vad_processor.get_finalized_utterance()` which returns the path to a temporary WAV file containing the detected speech segment and the VAD statistics string.
4.  **STT and Interview Logic**:
    - The server uses `WhisperSTT.transcribe(audio_path)` to convert the speech segment to text.
    - The VAD statistics, transcript, and a unique filename stump are logged to `logs/speech_metrics.csv` using `vad_processor.log_speech_metrics()`.
    - The transcript is passed to `_process_interview_turn(transcript_text)`.
    - `_process_interview_turn` interacts with the N8N webhook (AI logic) and updates the interview state (`state` global).
5.  **Send Response to Client**:
    - The server constructs a JSON message containing:
      - The AI's response text (`ai_response`).
      - The next question text (`next_question_text`), if any.
      - Current question number, total questions.
      - User's transcript from the last turn (`user_transcript`).
      - Interview completion status (`interview_complete`).
      - Flags like `is_follow_up_ask`.
    - This JSON message is sent back to the client via the WebSocket.

### 2.4. Loop or End Interview

1.  **Client (`socket.onmessage` in `app.js`)**:
    - Receives the server's response.
    - Updates the UI (displays user transcript, AI response, current question).
    - If the interview is not complete, the cycle repeats from step 3.2.1 (client receives message, may perform TTS, then listens).
2.  **Interview Completion**:
    - If the server message indicates `interview_complete: true`:
      - The client stops audio streaming.
      - Displays closing remarks and the final transcript.
      - The WebSocket connection may be closed.

## 3. Key File Changes and New Components

### 3.1. `api.py` (Server - Python/FastAPI)

- **Original**: Primarily HTTP-based, with an `/answer` endpoint for full audio uploads. TTS played on the server.
- **Changes**:
  - **New WebSocket Endpoint (`/ws/interview_audio`)**:
    - Manages the bi-directional communication for real-time audio.
    - Instantiates and uses `RealtimeVADProcessor` for VAD.
    - Receives audio chunks, triggers STT on finalized speech segments.
    - Calls `_process_interview_turn` for interview logic.
    - Sends structured JSON messages (AI responses, questions, state) back to the client.
    - Handles initial message to client and WebSocket disconnects.
  - **Modified `/speak_question` Endpoint**:
    - **Original**: Likely just triggered server-side TTS playback.
    - **New**: Accepts text, calls the modified `EdgeTTS.speak()` to save TTS audio to a file in `app/static/tts_audio/`, and returns a JSON response with the web-accessible `audio_url`.
  - **`_process_interview_turn(transcript_text)` function**:
    - Refactored and adapted to be called by the WebSocket endpoint after STT.
    - Core logic for interacting with N8N webhook and managing interview `state` remains, but now driven by live transcripts.
  - **State Management (`state` global variable)**:
    - Still a simple global dictionary. **Note**: This is suitable for single-user testing but needs to be refactored for session-based state management to support concurrent users.
  - **TTS Audio Directory (`TTS_AUDIO_DIR`)**:
    - Defined as `app/static/tts_audio/` and created on startup.
  - **Deprecated `/answer` endpoint**: While still present, it's marked as deprecated, and the primary flow uses WebSockets.

### 3.2. `app/static/app.js` (Client - JavaScript)

- **Original**: Handled recording (potentially with `MediaRecorder` and simple silence detection), submitted full audio via `fetch` to `/answer`, and updated UI based on HTTP response.
- **Changes**:
  - **WebSocket Implementation**:
    - `connectWebSocket()`: Establishes connection to `/ws/interview_audio`.
    - `socket.onopen`: Handles successful connection.
    - `socket.onmessage`: Core logic for receiving messages from the server, updating UI, triggering TTS, and deciding next actions based on server directives. This is the new driver of the interview flow.
    - `socket.onerror`, `socket.onclose`: Handle WebSocket errors and closures.
  - **Real-time Audio Streaming**:
    - `startAudioStreaming()`:
      - Uses `navigator.mediaDevices.getUserMedia()` for microphone access.
      - Initializes `AudioContext` and `ScriptProcessorNode`.
      - `scriptProcessorNode.onaudioprocess` callback:
        - Converts audio to 16-bit PCM.
        - Sends audio data in fixed-size chunks (matching server VAD config, e.g., 640 bytes for 20ms at 16kHz mono) over the WebSocket.
    - `stopAudioStreaming()`: Stops audio capture and releases resources.
  - **Client-Side TTS Playback (`speakText` function)**:
    - **New Function**: `speakText(textToSpeak, sourceDescription)`
    - Makes a `fetch` POST request to `/speak_question` on the server.
    - Receives `audio_url` in the response.
    - Creates an HTML `Audio` element, sets its `src`, and plays it.
    - Returns a Promise that resolves on audio `ended` or rejects on `error`.
    - Crucially used in `socket.onmessage` and `handlePostAIResponse` to play AI responses and questions, ensuring subsequent actions (like `startAudioStreaming`) wait for TTS completion.
  - **Modified Interview Flow Functions**:
    - `startInterviewWithWelcome()`: Now primarily calls `connectWebSocket()`. The subsequent flow is driven by messages received on the WebSocket.
    - `processNextQuestion()`: Now largely a placeholder or deprecated, as its responsibilities are taken over by the `socket.onmessage` handler and `handlePostAIResponse`.
    - `handlePostAIResponse(serverMessage)`: Helper function called from `socket.onmessage` (after AI response TTS or for direct prompts) to decide the next step, such as speaking a new question and/or starting audio streaming.
  - **Removal of Old Audio Logic**:
    - `recordAudioWithSilenceDetection()` and `checkForSilence()` (client-side VAD) have been removed.

### 3.3. `interview_logic/vad_processor.py` (New File - Python)

- **`RealtimeVADProcessor` Class**:
  - **Initialization**: Takes `log_directory`. Sets up VAD parameters (aggressiveness, frame duration, sample rate). Initializes `webrtcvad.Vad()`. Creates `speech_metrics.csv` with headers in the specified log directory. Parameters like `subsequent_idle_time_ms` and `min_speech_duration_ms` were tuned to improve responsiveness and reduce false triggers.
  - `process_audio_chunk(data)`:
    - Receives a raw audio chunk (bytes).
    - Determines if it's speech using `self.vad.is_speech()`.
    - Manages state (silence before speech, in speech, silence after speech).
    - Buffers speech frames.
    - Returns `True` if an utterance is considered final (based on trailing silence), `False` otherwise.
  - `get_finalized_utterance()`:
    - Called when `process_audio_chunk` indicates finality or on forced finalization.
    - Saves the buffered speech audio to a temporary WAV file.
    - Resets utterance state for the next turn.
    - Returns the path to the WAV file and a VAD statistics string.
  - `log_speech_metrics(vad_stats_str, transcript_text, audio_filename_stump)`:
    - Appends a new row to `speech_metrics.csv` with timestamp, filename stump, VAD stats, transcript, and processing time.
  - `_bytes_per_frame`, `_samples_per_frame`: Calculated based on configuration.

### 3.4. `interview_logic/TTS/edge_tts_engine.py` (Modified - Python)

- **`EdgeTTS.speak(self, text, output_filename=None)` method**:
  - **Original**: Played audio directly on the server using `simpleaudio` after saving to temporary files.
  - **New**:
    - Accepts an optional `output_filename`.
    - If `output_filename` is provided:
      - Saves the TTS audio (as MP3) directly to this path.
      - Does _not_ play audio on the server.
      - Returns `True` on success, `False` on failure.
    - If `output_filename` is `None`:
      - Maintains original behavior (plays on server, uses temp files, returns `True`/`False`). This path is not used by the main web flow anymore.

### 3.5. `requirements39.txt` (Modified)

- Added dependencies:
  - `webrtcvad==2.0.10` (for server-side VAD)
  - `websockets==12.0` (for FastAPI WebSocket support)

### 3.6. New Directories/Files (Generated or Added)

- `app/static/tts_audio/`: Directory created to store TTS MP3 files generated by the server, making them web-accessible for client-side playback.
- `logs/speech_metrics.csv`: CSV file automatically generated by `RealtimeVADProcessor` to log VAD and STT metrics for each speech segment.

## 4. Summary of Key Improvements

- **Enhanced User Experience**: Real-time VAD significantly reduces the recording/processing of dead air, leading to quicker turnarounds and a more natural conversational flow.
- **Robust VAD**: Server-side VAD using `webrtcvad` is generally more reliable and configurable than typical client-side JavaScript solutions. Tuned parameters further improve accuracy in distinguishing speech from silence.
- **Reduced Client Load**: Offloading VAD to the server simplifies client-side logic and reduces processing demands on the user's device.
- **Modular VAD Component**: `RealtimeVADProcessor` is a self-contained class, making it easier to manage and potentially reuse.
- **Correct TTS Playback**: TTS audio is now generated by the server, but the audio file URL is sent to the client, and the client's browser plays the audio. This is crucial for web applications.
- **Comprehensive Metrics Logging**: VAD statistics and transcription results are logged, providing valuable data for performance analysis, debugging, and model improvement.
- **Lower Latency Interaction**: WebSockets provide a persistent, low-latency channel for audio streaming and message passing, compared to repeated HTTP requests.
- **Clearer Error Handling**: Refined error handling for microphone access and TTS playback on the client-side.
- **Accurate UI Feedback**: Ensured UI elements like the question progress counter (`Question X of Y`) update correctly based on WebSocket messages from the server.
- **Corrected Audio Chunking**: Resolved issues with client-side audio chunking to ensure precise VAD frame sizes are sent to the server, eliminating VAD processor warnings.

This overhaul provides a more sophisticated and robust foundation for the `BasicInterviewer` application.
