from fastapi import FastAPI, UploadFile, File, Form, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from interview_logic.TTS.edge_tts_engine import EdgeTTS
from interview_logic.STT.whisper_stt import WhisperSTT
from interview_logic.vad_processor import RealtimeVADProcessor
import tempfile, shutil, os
import requests
import json
import uuid

app = FastAPI()
app.mount("/static", StaticFiles(directory="app/static"), name="static")

# Define a directory for TTS audio files within the static path
TTS_AUDIO_DIR = "app/static/tts_audio"
os.makedirs(TTS_AUDIO_DIR, exist_ok=True)
# Also mount this specific directory if needed, or rely on the parent /static mount
# For simplicity, we'll assume /static/tts_audio/... will be accessible.

stt = WhisperSTT()
tts = EdgeTTS()

# Shared state across requests - NB: This will need to be session-based for concurrent users
state = {
    "mode": None,
    "questions": [],
    "index": 0,
    "is_interview_complete": False,
    "transcript": [] # Ensure transcript is initialized
}

# Helper function refactored from the original /answer endpoint
async def _process_interview_turn(transcript_text: str):
    print(f"[API _process_interview_turn] Processing transcript: {transcript_text}")

    if state.get("is_interview_complete", False):
        print("[API _process_interview_turn] Interview already marked complete.")
        return {
            "interview_complete": True,
            "transcript_history": state.get("transcript", []),
            "ai_response": "The interview has already concluded.",
            "next_question_text": None,
            "question_number": state.get("index", 0) + 1,
            "user_transcript": transcript_text
        }

    current_index = state.get("index", 0)
    
    if not state.get("questions"):
        print("[API _process_interview_turn] ❌ No questions available!")
        state["is_interview_complete"] = True
        return {
            "interview_complete": True,
            "transcript_history": state.get("transcript", []),
            "ai_response": "No questions were loaded for the interview.",
            "next_question_text": None,
            "question_number": current_index + 1,
            "user_transcript": transcript_text
        }

    if current_index >= len(state["questions"]):
        print(f"[API _process_interview_turn] Index {current_index} is beyond available questions. Ending interview.")
        state["is_interview_complete"] = True
        # Ensure the last human response is added before concluding
        if transcript_text:
             state["transcript"].append({"speaker": "Human", "text": transcript_text})
        return {
            "interview_complete": True,
            "transcript_history": state.get("transcript", []),
            "ai_response": "That was the last question. Thank you!",
            "next_question_text": None,
            "question_number": current_index, # Refers to the question just answered
            "user_transcript": transcript_text
        }

    current_question = state["questions"][current_index]["question"]

    # Add current question and human response to transcript
    # Check if the last entry was this question to avoid duplication if processing retries
    last_transcript_entry = state["transcript"][-1] if state["transcript"] else None
    if not last_transcript_entry or not (last_transcript_entry.get("speaker") == "AI" and last_transcript_entry.get("text") == current_question):
        state["transcript"].append({"speaker": "AI", "text": current_question, "question_number": current_index + 1})
    
    if transcript_text: # Only add human response if STT produced something
        state["transcript"].append({"speaker": "Human", "text": transcript_text})

    payload = {
        "questions": [q["question"] for q in state["questions"]],
        "current_question_index": current_index, # 0-based index
        "current_question_text": current_question,
        "transcript": state["transcript"] # Send the full transcript history
    }

    print(f"[API _process_interview_turn] Sending webhook for question #{current_index + 1}: {current_question}")
    webhook_url = "https://hudmarr.app.n8n.cloud/webhook/fb613c07-aa88-4fbd-a3c9-ba4cdf7387a9" # Ensure this is correct
    
    ai_response_text = "Error processing your response." # Default
    next_q_text = None
    is_follow_up_from_ai = False
    interview_just_completed = False

    try:
        response = requests.post(webhook_url, json=payload, timeout=20) # Increased timeout
        response.raise_for_status() # Raise an exception for HTTP errors
        data = response.json()
        print(f"[API _process_interview_turn] Webhook response data: {data}")

        if "output" not in data:
            print("[API _process_interview_turn] No 'output' in webhook response")
            # Keep ai_response_text as default error, don't advance
            return {
                "interview_complete": state["is_interview_complete"],
                "transcript_history": state["transcript"],
                "ai_response": ai_response_text,
                "next_question_text": state["questions"][current_index]["question"] if not state["is_interview_complete"] else None, # Repeat current or signal end
                "question_number": current_index + 1,
                "user_transcript": transcript_text,
                "error": "Webhook response missing 'output' field."
            }

        parsed_output = json.loads(data["output"]) # Assuming 'output' is a JSON string
        print(f"[API _process_interview_turn] Parsed webhook output: {parsed_output}")

        ai_response_text = parsed_output.get("response", "I'm not sure how to respond to that.")
        is_follow_up_from_ai = parsed_output.get("is_follow_up", False)

        if is_follow_up_from_ai:
            print(f"[API _process_interview_turn] Handling follow-up: {ai_response_text}")
            state["transcript"].append({"speaker": "AI", "text": ai_response_text, "is_followup": True})
            # For a follow-up, the "next question" is the follow-up itself. The index doesn't change yet.
            next_q_text = ai_response_text 
        else:
            # Not a follow-up, so this AI response is a transition to the next question or end.
            state["transcript"].append({"speaker": "AI", "text": ai_response_text, "transition_to": current_index + 2 if current_index + 1 < len(state["questions"]) else "end"})
            
            state["index"] += 1 # Move to next question index
            next_actual_index = state["index"]

            if next_actual_index >= len(state["questions"]):
                print("[API _process_interview_turn] No more questions after this response. Ending interview.")
                state["is_interview_complete"] = True
                interview_just_completed = True
                next_q_text = None # No more questions
            else:
                next_q_text = state["questions"][next_actual_index]["question"]
        
    except requests.exceptions.RequestException as e:
        print(f"[API _process_interview_turn] Webhook request error: {str(e)}")
        # Return current question, don't advance state
        return {
            "interview_complete": state["is_interview_complete"], # could be true if it failed on last q
            "transcript_history": state["transcript"],
            "ai_response": f"There was an error communicating with the interview logic: {str(e)}",
            "next_question_text": state["questions"][current_index]["question"] if not state["is_interview_complete"] else None,
            "question_number": current_index + 1,
            "user_transcript": transcript_text,
            "error": f"Webhook request failed: {str(e)}"
        }
    except json.JSONDecodeError as e:
        print(f"[API _process_interview_turn] Error decoding JSON from webhook: {str(e)}. Response text: {data.get('output', 'N/A') if isinstance(data, dict) else response.text}")
        return {
            "interview_complete": state["is_interview_complete"],
            "transcript_history": state["transcript"],
            "ai_response": "There was an error decoding the response from the interview logic.",
            "next_question_text": state["questions"][current_index]["question"] if not state["is_interview_complete"] else None,
            "question_number": current_index + 1,
            "user_transcript": transcript_text,
            "error": f"Webhook JSON decode error: {str(e)}"
        }

    # Construct response for client
    client_response = {
        "interview_complete": state["is_interview_complete"],
        "transcript_history": state.get("transcript", []),
        "ai_response": ai_response_text, # This is the immediate TTS response from AI
        "next_question_text": next_q_text if not interview_just_completed else None, # Actual text of next question or null
        "question_number": state["index"] + 1 if not interview_just_completed else current_index +1, # 1-based index of the *next* question or current if ended
        "user_transcript": transcript_text,
        "is_follow_up_ask": is_follow_up_from_ai # Tells client if the AI's response IS a follow-up question
    }
    
    if interview_just_completed: # If interview ended as part of this turn
        client_response["question_number"] = len(state["questions"]) # Show total questions count or similar

    print(f"[API _process_interview_turn] Response to client: {client_response}")
    return client_response

@app.get("/")
async def serve_home(): # Changed to async to align
    return FileResponse("app/static/index.html")

@app.get("/start")
async def start_interview(mode: str, request: Request): # Added request for client host
    state["mode"] = mode
    state["index"] = 0
    # Reset questions based on mode
    if mode == "preset":
        # Example: load from a default preset or a specific one
        state["questions"] = [{"question": "Tell me about yourself."},{"question": "What is your greatest strength?"}, {"question": "Where do you see yourself in 5 years?"}]
    else: # Custom mode
        state["questions"] = [] # Custom questions to be added via /submit_custom_question

    state["transcript"] = []
    state["is_interview_complete"] = False
    
    print(f"[API /start] Interview started. Mode: {mode}, Initial state: {state}")

    if state["questions"]:
        first_q = state["questions"][0]["question"]
        # TTS for the first question is handled by client asking /speak_question or via WebSocket response now
        return {"status": "started", "message": "Interview started.", "initial_question": first_q, "question_number": 1}
    else: # Custom mode, no initial questions
        # Client should prompt for first custom question or server sends a generic prompt
        return {"status": "started_custom_mode", "message": "Interview started in custom mode. Please add questions.", "initial_question": None, "question_number": 0}


@app.post("/submit_custom_question")
async def add_custom_question(request: Request):
    data = await request.json()
    q_text = data.get("question")
    if q_text:
        state["questions"].append({"question": q_text})
        print(f"[API /submit_custom_question] Custom question added: {q_text}. Total questions: {len(state['questions'])}")
        # If this is the first question added in custom mode, return it so client can display/speak
        if len(state["questions"]) == 1 and state["mode"] == "custom":
             return {"ok": True, "first_custom_question_added": q_text, "question_number": 1}
        return {"ok": True}
    return JSONResponse(content={"error": "No question text provided"}, status_code=400)

# The old /answer endpoint - can be deprecated or kept for non-streaming tests
@app.post("/answer")
async def submit_answer_deprecated(
    request: Request, # Keep for consistency, though not used as much here
    file: UploadFile = File(...),
    # is_followup: bool = Form(False) # This form field is less relevant with new flow
):
    print("[API /answer DEPRECATED] Endpoint hit. Consider using WebSocket.")
    
    # This endpoint is now less primary. For testing, it can still work but won't have real-time VAD.
    # It could simulate the VAD process on the uploaded file if needed for some tests.
    # For now, let it just transcribe and process one turn.

    if state.get("is_interview_complete", False):
        return JSONResponse(status_code=400, content={"error": "Interview already complete."})

    try:
        temp_dir = "temp_audio_uploads"
        os.makedirs(temp_dir, exist_ok=True)
        audio_path = os.path.join(temp_dir, f"{uuid.uuid4()}.wav")

        with open(audio_path, "wb") as tmp_file:
            shutil.copyfileobj(file.file, tmp_file)

        print(f"[API /answer DEPRECATED] Transcribing {audio_path}...")
        transcript_text = stt.transcribe(audio_path)
        print(f"[API /answer DEPRECATED] Transcript: {transcript_text}")
        
        # Simulate logging for the deprecated endpoint if desired (without full VAD string)
        # metrics_logger = RealtimeVADProcessor() # Temporary instance for logging structure
        # metrics_logger.log_speech_metrics("", transcript_text, os.path.basename(audio_path))

        os.remove(audio_path) # Clean up

        if not transcript_text.strip():
             print("[API /answer DEPRECATED] Empty transcript.")
             # Return a message indicating no speech detected, client should handle this
             current_q_text = state["questions"][state["index"]]["question"] if state["index"] < len(state["questions"]) else "No current question."
             return JSONResponse(content={
                 "status": "no_speech_detected",
                 "ai_response": "I didn't catch that. Could you please repeat?",
                 "next_question_text": current_q_text, # Repeat current question
                 "question_number": state["index"] + 1,
                 "transcript_history": state["transcript"],
                 "user_transcript": ""
             })

        response_data = await _process_interview_turn(transcript_text)
        return JSONResponse(content=response_data)

    except Exception as e:
        print(f"[API /answer DEPRECATED ERROR] {str(e)}")
        return JSONResponse(status_code=500, content={"error": str(e), "transcript": "Error processing audio."})


@app.websocket("/ws/interview_audio")
async def websocket_interview_endpoint(websocket: WebSocket):
    await websocket.accept()
    vad_processor = RealtimeVADProcessor(log_directory="logs/ws_audio") # Instance per connection
    
    # Example of sending an initial message which might contain the first question
    initial_message_to_client = {
        "type": "interview_ready",
        "message": "Interview session started. Waiting for configuration or first question."
    }
    # This should be more dynamic based on /start endpoint's setup
    if state.get("questions") and len(state["questions"]) > 0 and not state.get("is_interview_complete"):
        first_q_text = state["questions"][0]["question"]
        initial_message_to_client.update({
            "current_question_text": first_q_text,
            "question_number": 1,
            "questions_total": len(state["questions"]),
            "action": "speak_and_listen" # Client should speak this question then listen
        })
    elif state.get("mode") == "custom" and not state.get("questions"):
        initial_message_to_client.update({
            "message": "Custom interview mode. Please add questions via the UI.",
            "action": "prompt_custom_question" # Client should show UI for custom questions
        })
    
    await websocket.send_json(initial_message_to_client)
    print(f"[API /ws/interview_audio] Sent initial message to client: {initial_message_to_client}")


    try:
        while True:
            # Client can send a special message to signal it's done with current question's audio
            # Or send audio data directly. For now, expect audio bytes.
            data = await websocket.receive_bytes()
            
            # print(f"Received chunk of size: {len(data)}") # For debugging
            is_utterance_final = vad_processor.process_audio_chunk(data)

            if is_utterance_final:
                print("[WS API] Utterance finalized by VAD.")
                audio_path, vad_str = vad_processor.get_finalized_utterance()
                
                transcript_text = ""
                if audio_path:
                    print(f"[WS API] Transcribing audio: {audio_path}")
                    transcript_text = stt.transcribe(audio_path)
                    print(f"[WS API] Transcript: '{transcript_text}'")
                    
                    log_filename = os.path.basename(audio_path) # Will be unique from tempfile
                    vad_processor.log_speech_metrics(vad_str, transcript_text, log_filename)
                    
                    try:
                        os.remove(audio_path)
                    except OSError as e:
                        print(f"[WS API] Error removing temp audio file {audio_path}: {e}")
                else:
                    print("[WS API] No audio path from VAD, likely no speech detected or too short.")
                    # Log empty attempt, VAD string might contain silence data
                    vad_processor.log_speech_metrics(vad_str if vad_str else "", "", "no_valid_audio_segment")


                if transcript_text.strip():
                    response_data = await _process_interview_turn(transcript_text)
                    await websocket.send_json(response_data)
                else: # No actual text from user
                    print("[WS API] Empty transcript after VAD processing.")
                    current_q_text = "Please try responding again." # Default if question state is off
                    if state["index"] < len(state["questions"]):
                         current_q_text = state["questions"][state["index"]]["question"]
                    
                    await websocket.send_json({
                        "status": "no_speech_detected",
                        "ai_response": "I didn't catch that clearly. Could you please say that again?",
                        "next_question_text": current_q_text, # Prompt to retry current question
                        "question_number": state["index"] + 1,
                        "transcript_history": state["transcript"],
                        "user_transcript": "",
                        "interview_complete": state["is_interview_complete"]
                    })
                
                # VAD processor state is reset within get_finalized_utterance for the next utterance
                # vad_processor._reset_utterance_state() # Already called internally
    
    except WebSocketDisconnect:
        print(f"[WS API] Client {websocket.client} disconnected.")
        # Handle forced finalization if есть buffered audio
        if vad_processor.user_has_started_speaking_this_turn and not vad_processor.utterance_finalized:
            print("[WS API] Processing remaining audio from disconnected client.")
            audio_path, vad_str = vad_processor.get_finalized_utterance() # Force finalization
            if audio_path:
                transcript_text = stt.transcribe(audio_path)
                log_filename = os.path.basename(audio_path)
                vad_processor.log_speech_metrics(vad_str, transcript_text, log_filename)
                # No client to send response to, but could log the final processing attempt.
                print(f"[WS API] Processed final utterance from disconnected client. Transcript: '{transcript_text}'")
                try:
                    os.remove(audio_path)
                except OSError as e:
                    print(f"[WS API] Error removing temp audio file {audio_path} on disconnect: {e}")
            else:
                 vad_processor.log_speech_metrics(vad_str if vad_str else "", "", "no_audio_on_disconnect")
    except Exception as e:
        print(f"[WS API] Error in WebSocket: {str(e)}")
        # Attempt to inform client if possible
        try:
            await websocket.send_json({"error": "An internal server error occurred during the WebSocket session."})
        except Exception:
            pass # Client might already be gone
    finally:
        print(f"[WS API] Closing WebSocket connection for {websocket.client}.")
        # Ensure VAD state is fully reset if it wasn't already (e.g. abrupt error)
        vad_processor._reset_utterance_state()


@app.post("/speak_question")
async def speak_question_endpoint(request: Request):
    data = await request.json()
    question_text = data.get("question") # Changed from 'question' to 'question_text' for clarity
    
    if not question_text:
        return JSONResponse(status_code=400, content={"error": "No question text provided."})

    try:
        # Generate a unique filename for the TTS audio output
        unique_id = uuid.uuid4()
        output_filename_base = f"tts_output_{unique_id}.mp3"
        # Full path to save the audio file
        full_output_path = os.path.join(TTS_AUDIO_DIR, output_filename_base)
        
        # Web-accessible path (relative to static mount)
        web_accessible_path = f"/static/tts_audio/{output_filename_base}"

        print(f"[API /speak_question] Generating TTS for: '{question_text}'. Saving to: {full_output_path}")
        
        # Call the modified tts.speak to save the file
        success = await tts.speak(question_text, output_filename=full_output_path)
        
        if success:
            print(f"[API /speak_question] TTS audio generated successfully: {web_accessible_path}")
            return JSONResponse(content={
                "status": "success", 
                "message": "TTS audio generated.",
                "audio_url": web_accessible_path, # URL for the client to fetch/play
                "original_text": question_text
            })
        else:
            print(f"[API /speak_question] TTS generation failed for: '{question_text}'")
            return JSONResponse(status_code=500, content={"error": "TTS generation failed."})
            
    except Exception as e:
        print(f"[API /speak_question] Error during TTS processing: {str(e)}")
        return JSONResponse(status_code=500, content={"error": f"Server error during TTS processing: {str(e)}"})

@app.get("/get_transcript") # Changed from @app.get("/transcript")
async def get_full_transcript(): # Renamed to avoid conflict
    return JSONResponse(content={"transcript": state.get("transcript", [])})

@app.post("/end_interview")
async def end_interview_session(): # Renamed
    print("[API /end_interview] Client explicitly ended interview.")
    state["is_interview_complete"] = True
    # Potentially add a final "Interview ended by user" to transcript
    state["transcript"].append({"speaker": "System", "text": "Interview ended by user."})
    return {"status": "success", "message": "Interview ended."}

# Example for loading presets (remains largely the same)
@app.get("/load_preset/{preset_id}")
async def load_preset_questions(preset_id: str): # Renamed, made async
    presets = {
        "microsoft": [
            "Tell me about a time you overcame a technical challenge.",
            "Describe a project where you had to collaborate with others.",
            "Why do you want to work at Microsoft?"
        ],
        "mcdonalds": [
            "Why do you want to be a manager at McDonald's?",
            "How do you handle customer complaints?",
            "Describe a time you had to lead a team under pressure."
        ],
        # ... other presets
    }
    if preset_id in presets:
        state["questions"] = [{"question": q} for q in presets[preset_id]]
        state["mode"] = preset_id # or "preset"
        state["index"] = 0
        state["transcript"] = []
        state["is_interview_complete"] = False
        print(f"[API /load_preset] Loaded preset {preset_id}. Questions: {len(state['questions'])}")
        if state["questions"]:
            return {"status": "preset_loaded", "initial_question": state["questions"][0]["question"], "question_number": 1, "questions": state["questions"]}
        else:
            return JSONResponse(content={"error": "Preset is empty or invalid."}, status_code=404)
    return JSONResponse(content={"error": "Preset not found."}, status_code=404)

# Note: The /popular endpoint was removed as it wasn't essential to the core logic being modified.
# If needed, it can be added back:
@app.get("/popular")
async def serve_popular_page(): # Made async to align with other FileResponse routes
   return FileResponse("app/static/popular.html")

# It's crucial that the client-side JavaScript is updated to:
# 1. Connect to the `/ws/interview_audio` WebSocket.
# 2. Stream audio data in chunks (e.g., every 100-250ms) that match `vad_processor.bytes_per_frame`.
# 3. Send a start message if needed (e.g., after /start is called and first question is received).
# 4. Receive JSON messages from the server (transcripts, AI responses, next questions, errors).
# 5. Handle TTS for AI responses and next questions.
# 6. Update the UI accordingly.
# The global `state` in api.py will NOT support concurrent users. Each WebSocket connection
# would need its own isolated state for a multi-user system.
