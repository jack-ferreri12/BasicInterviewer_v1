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
from starlette.websockets import WebSocketState
import time
import asyncio

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
    "transcript": [], # Ensure transcript is initialized
    "latest_transcript": "",
    "latest_transcript_ready": False
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
    vad_processor = RealtimeVADProcessor(log_directory="logs/ws_audio")
    client_host = websocket.client.host if websocket.client else "UnknownClient"
    print(f"[WS API {client_host}] Audio socket connection accepted.")
    
    try:
        # This endpoint is now AUDIO ONLY - only process binary chunks
        audio_chunks_received_this_utterance = 0
        
        while True:
            try:
                message_data = await websocket.receive()
                
                if message_data.get("type") == "websocket.disconnect":
                    print(f"[WS API {client_host}] Audio socket client disconnected.")
                    raise WebSocketDisconnect(code=message_data.get('code', 1000))
                
                # Handle text messages (for control commands only on this socket)
                if "text" in message_data:
                    try:
                        text_message = json.loads(message_data["text"])
                        if text_message.get("type") == "client_audio_ended":
                            print(f"[WS API {client_host}] Received audio end signal on audio socket.")
                            await websocket.send_json({"type": "audio_ended_ack"})
                            # Reset VAD for next utterance
                            vad_processor.reset_state()
                            audio_chunks_received_this_utterance = 0
                            continue
                    except json.JSONDecodeError:
                        print(f"[WS API {client_host}] Invalid JSON on audio socket: {message_data['text']}")
                        continue
                
                # Process binary audio data
                if "bytes" in message_data:
                    audio_chunk = message_data["bytes"]
                    audio_chunks_received_this_utterance += 1
                    
                    # Process through VAD
                    is_utterance_final = vad_processor.process_audio_chunk(audio_chunk)
                    
                    # If VAD detects end of utterance, finalize and notify control socket
                    if is_utterance_final:
                        print(f"[WS API {client_host}] Utterance finalized by VAD after {audio_chunks_received_this_utterance} chunks.")
                        audio_path, vad_str = vad_processor.get_finalized_utterance()
                        
                        if audio_path:
                            print(f"[WS API {client_host}] Transcribing audio: {audio_path}")
                            transcript_text = stt.transcribe(audio_path)
                            print(f"[WS API {client_host}] Transcript: '{transcript_text}'")
                            vad_processor.log_speech_metrics(vad_str, transcript_text, os.path.basename(audio_path))
                            
                            # Save the transcript in state for the control socket to access
                            state["latest_transcript"] = transcript_text
                            state["latest_transcript_ready"] = True
                            
                            try:
                                os.remove(audio_path)
                            except OSError as e_remove:
                                print(f"[WS API {client_host}] Error removing temp audio file {audio_path}: {e_remove}")
                        else:
                            print(f"[WS API {client_host}] No audio path from VAD (no speech or too short).")
                            state["latest_transcript"] = ""
                            state["latest_transcript_ready"] = True
                            vad_processor.log_speech_metrics(vad_str or "", "", "no_valid_audio_segment")
                        
                        # Reset for next utterance
                        vad_processor.reset_state()
                        audio_chunks_received_this_utterance = 0
                        
                        # Send notification that we finished processing
                        await websocket.send_json({"type": "utterance_processed"})
            
            except Exception as e_audio_recv:
                print(f"[WS API {client_host}] Error during audio processing: {type(e_audio_recv).__name__} - {e_audio_recv}")
                # Don't close on individual errors, try to continue
    
    except WebSocketDisconnect:
        print(f"[WS API {client_host}] Audio socket client disconnected.")
    except Exception as e_main:
        print(f"[WS API {client_host}] Fatal error in audio socket: {type(e_main).__name__} - {e_main}")
    finally:
        # Make sure to cleanup
        try:
            if websocket.client_state != WebSocketState.DISCONNECTED:
                print(f"[WS API {client_host}] Attempting to close audio WebSocket (client_state: {websocket.client_state}).")
                await websocket.close()
        except RuntimeError as e_close:
            print(f"[WS API {client_host}] Info: RuntimeError during final close (client_state check), possibly already closing/closed: {e_close}")
        except Exception as e_close_other:
            print(f"[WS API {client_host}] Error during final audio socket close: {type(e_close_other).__name__} - {e_close_other}")

@app.websocket("/ws/interview_control")
async def websocket_control_endpoint(websocket: WebSocket):
    await websocket.accept()
    client_host = websocket.client.host if websocket.client else "UnknownClient"
    print(f"[WS API {client_host}] WebSocket connection accepted.")

    # Create a VAD processor instance for this connection
    vad_processor = RealtimeVADProcessor(log_directory="logs/ws_audio")
    audio_chunks_received_this_utterance = 0
    current_turn_requires_tts_handshake = False

    try:
        # --- Initial Message to Client ---
        initial_payload_to_client = {
            "type": "interview_ready",
            "message": "Interview session starting...",
            "action": "speak_and_listen", # Default, will be refined
            "current_question_text": None,
            "question_number": 0,
            "questions_total": len(state.get("questions", [])),
            "transcript_history": state.get("transcript", []),
            "interview_complete": state.get("is_interview_complete", False),
            "is_follow_up_ask": False
        }

        if state.get("is_interview_complete"):
            initial_payload_to_client.update({
                "message": "Interview has already concluded.",
                "action": "end_interview"
            })
            current_turn_requires_tts_handshake = False
        elif state.get("questions") and state["index"] < len(state["questions"]):
            current_q_text = state["questions"][state["index"]]["question"]
            initial_payload_to_client.update({
                "current_question_text": current_q_text,
                "question_number": state["index"] + 1,
                "message": "Please listen to the first question.",
                "action": "speak_and_listen"
            })
            if not any(entry.get("text") == current_q_text and entry.get("speaker") == "AI" for entry in state.get("transcript", [])):
                 state.get("transcript", []).append({"speaker": "AI", "text": current_q_text, "question_number": state["index"] + 1})
            current_turn_requires_tts_handshake = True
        elif state.get("mode") == "custom" and not state.get("questions"):
            initial_payload_to_client.update({
                "message": "Custom interview mode. Please add questions via the UI first.",
                "action": "prompt_custom_question"
            })
            current_turn_requires_tts_handshake = False
        else:
            initial_payload_to_client.update({
                "message": "Interview setup is incomplete. Please restart.",
                "action": "end_interview",
                "error": "Interview state not properly initialized."
            })
            current_turn_requires_tts_handshake = False
    
        await websocket.send_json(initial_payload_to_client)
        print(f"[WS API {client_host}] Sent initial payload: {json.dumps(initial_payload_to_client, indent=2)}")

        if initial_payload_to_client["action"] == "end_interview":
            # No need to call websocket.close() here if we are about to return,
            # as the finally block will handle it.
            print(f"[WS API {client_host}] Initial action is end_interview. Endpoint will exit.")
            return

        # --- Main Interaction Loop ---
        while not state.get("is_interview_complete", False):
            if current_turn_requires_tts_handshake:
                # Wait for TTS to complete before prompting for audio
                print(f"[WS API {client_host}] Waiting for 'tts_complete' from client...")
                received_tts_complete = False
                
                while not received_tts_complete:
                    try:
                        message_data = await websocket.receive()
                        
                        if message_data.get("type") == "websocket.disconnect":
                            print(f"[WS API {client_host}] Client disconnected while waiting for 'tts_complete'. Code: {message_data.get('code')}")
                            raise WebSocketDisconnect(code=message_data.get('code', 1000))
                            
                        if "text" in message_data:
                            tts_msg_str = message_data["text"]
                            try:
                                tts_msg = json.loads(tts_msg_str)
                                if tts_msg.get("type") == "tts_complete":
                                    print(f"[WS API {client_host}] Received 'tts_complete'.")
                                    received_tts_complete = True
                                    break
                                elif tts_msg.get("type") == "client_audio_ended":
                                    print(f"[WS API {client_host}] Client sent 'client_audio_ended' during TTS handshake. Strange but not fatal.")
                                else:
                                    print(f"[WS API {client_host}] Expected 'tts_complete', got other message: {tts_msg_str}")
                            except json.JSONDecodeError:
                                print(f"[WS API {client_host}] Invalid JSON while waiting for 'tts_complete': {tts_msg_str}")
                    except Exception as e_tts_complete:
                        print(f"[WS API {client_host}] Error waiting for 'tts_complete': {type(e_tts_complete).__name__} - {e_tts_complete}")
                        break
                
                # Signal client it's time to start listening
                await websocket.send_json({"type": "ready_to_listen"})
                print(f"[WS API {client_host}] Sent 'ready_to_listen'.")
            
            # Wait for client to indicate audio has ended or receive audio data
            print(f"[WS API {client_host}] Waiting for audio data or 'client_audio_ended'...")
            received_client_audio_ended = False
            state["latest_transcript_ready"] = False
            state["latest_transcript"] = ""
            
            # Set a timeout for waiting
            polling_start_time = time.time()
            max_polling_seconds = 60  # Maximum time to wait for a response
            
            while not received_client_audio_ended and not state.get("latest_transcript_ready", False):
                try:
                    message_data = await websocket.receive()
                    
                    if message_data.get("type") == "websocket.disconnect":
                        print(f"[WS API {client_host}] Client disconnected during audio. Code: {message_data.get('code')}")
                        raise WebSocketDisconnect(code=message_data.get('code', 1000))
                    
                    # Handle text messages
                    if "text" in message_data:
                        audio_end_msg_str = message_data["text"]
                        try:
                            audio_end_msg = json.loads(audio_end_msg_str)
                            if audio_end_msg.get("type") == "client_audio_ended":
                                print(f"[WS API {client_host}] Received explicit 'client_audio_ended'.")
                                received_client_audio_ended = True
                                break
                        except json.JSONDecodeError:
                            print(f"[WS API {client_host}] Invalid JSON in audio phase: {audio_end_msg_str}")
                    
                    # Handle binary audio data
                    elif "bytes" in message_data:
                        audio_chunk = message_data["bytes"]
                        audio_chunks_received_this_utterance += 1
                        
                        # Process through VAD
                        is_utterance_final = vad_processor.process_audio_chunk(audio_chunk)
                        
                        # If VAD detects end of utterance, finalize
                        if is_utterance_final:
                            print(f"[WS API {client_host}] Utterance finalized by VAD after {audio_chunks_received_this_utterance} chunks.")
                            audio_path, vad_str = vad_processor.get_finalized_utterance()
                            
                            if audio_path:
                                print(f"[WS API {client_host}] Transcribing audio: {audio_path}")
                                transcript_text = stt.transcribe(audio_path)
                                print(f"[WS API {client_host}] Transcript: '{transcript_text}'")
                                vad_processor.log_speech_metrics(vad_str, transcript_text, os.path.basename(audio_path))
                                
                                # Save the transcript for processing
                                state["latest_transcript"] = transcript_text
                                state["latest_transcript_ready"] = True
                    
                    try:
                        os.remove(audio_path)
                                except OSError as e_remove:
                                    print(f"[WS API {client_host}] Error removing temp audio file {audio_path}: {e_remove}")
                else:
                                print(f"[WS API {client_host}] No audio path from VAD (no speech or too short).")
                                state["latest_transcript"] = ""
                                state["latest_transcript_ready"] = True
                                vad_processor.log_speech_metrics(vad_str or "", "", "no_valid_audio_segment")
                            
                            # Reset for next utterance
                            vad_processor.reset_state()
                            audio_chunks_received_this_utterance = 0
                            break
                    
                    # Check for timeout
                    if time.time() - polling_start_time > max_polling_seconds:
                        print(f"[WS API {client_host}] Timeout waiting for audio")
                        break
                
                except Exception as e_audio:
                    print(f"[WS API {client_host}] Error during audio processing: {type(e_audio).__name__} - {e_audio}")
                    break
            
            # --- Process transcript and send response ---
            transcript_text = state.get("latest_transcript", "")

                if transcript_text.strip():
                    response_data = await _process_interview_turn(transcript_text)
                if not response_data.get("interview_complete"):
                    response_data["action"] = "speak_and_listen"
                    current_turn_requires_tts_handshake = True 
                else:
                    response_data["action"] = "end_interview"
                    current_turn_requires_tts_handshake = False
                
                    await websocket.send_json(response_data)
                print(f"[WS API {client_host}] Sent turn response: {json.dumps(response_data, indent=2)}")
            else: 
                print(f"[WS API {client_host}] Empty transcript or no utterance detected.")
                current_q_text_retry = "Please try responding again."
                current_q_num_retry = state["index"] + 1
                is_interview_now_complete = state.get("is_interview_complete", False)

                if not is_interview_now_complete and state["index"] < len(state["questions"]):
                    current_q_text_retry = state["questions"][state["index"]]["question"]
                else:
                    is_interview_now_complete = True
                
                no_speech_payload = {
                    "type": "no_speech_detected", 
                        "status": "no_speech_detected",
                        "ai_response": "I didn't catch that clearly. Could you please say that again?",
                    "next_question_text": current_q_text_retry,
                    "question_number": current_q_num_retry,
                    "transcript_history": state.get("transcript", []),
                        "user_transcript": "",
                    "interview_complete": is_interview_now_complete,
                    "action": "speak_and_listen" if not is_interview_now_complete else "end_interview"
                }
                await websocket.send_json(no_speech_payload)
                print(f"[WS API {client_host}] Sent no_speech_detected payload: {json.dumps(no_speech_payload, indent=2)}")
                if not is_interview_now_complete:
                    current_turn_requires_tts_handshake = True
                else:
                    state["is_interview_complete"] = True

            if state.get("is_interview_complete"):
                print(f"[WS API {client_host}] Interview is now complete. Exiting main loop.")
                break
    
    except WebSocketDisconnect:
        print(f"[WS API {client_host}] Client disconnected.")
    except Exception as e_main_loop:
        print(f"[WS API {client_host}] Error in main loop: {type(e_main_loop).__name__} - {e_main_loop}")
        try:
            await websocket.send_json({"type": "error", "message": f"Server error: {type(e_main_loop).__name__}", "action": "end_interview"})
        except Exception:
            print(f"[WS API {client_host}] Failed to send error to client, already disconnected.")
    finally:
        # Clean up VAD processor
        vad_processor.reset_state()
        
        # Close the WebSocket if not already closed
        try:
            if websocket.client_state != WebSocketState.DISCONNECTED:
                print(f"[WS API {client_host}] Closing WebSocket (client_state: {websocket.client_state}).")
                await websocket.close()
        except RuntimeError as e_close:
            print(f"[WS API {client_host}] Info: RuntimeError during final close, possibly already closing/closed: {e_close}")
        except Exception as e_close_other:
            print(f"[WS API {client_host}] Error during final WebSocket close: {type(e_close_other).__name__} - {e_close_other}")

@app.post("/speak_question")
async def speak_question_endpoint(request: Request):
    client_host = request.client.host if request and request.client else "unknown"
    start_time = time.time()
    
    print(f"[API /speak_question {client_host}] Endpoint hit at {time.strftime('%H:%M:%S')}")
    
    try:
        # Set a timeout for the entire request
        request_body = await asyncio.wait_for(request.json(), timeout=5.0)
        question_text = request_body.get("question")
        
        if not question_text:
            print(f"[API /speak_question {client_host}] No question text provided")
            return JSONResponse(status_code=400, content={"error": "No question text provided."})

        # Add request timeout for robustness
        request_timeout = 15.0  # seconds (reduced from 30s)
        
        # Generate a unique filename for the TTS audio output
        unique_id = uuid.uuid4()
        output_filename_base = f"tts_output_{unique_id}.mp3"
        # Full path to save the audio file
        full_output_path = os.path.join(TTS_AUDIO_DIR, output_filename_base)
        
        # Web-accessible path (relative to static mount)
        web_accessible_path = f"/static/tts_audio/{output_filename_base}"

        print(f"[API /speak_question {client_host}] Generating TTS for: '{question_text[:50]}...' ({len(question_text)} chars). Saving to: {full_output_path}")
        
        # Try fallback voices if needed
        fallback_voices = ["en-US-GuyNeural", "en-GB-SoniaNeural"]
        primary_voice = "en-US-AriaNeural"  # Default voice
        
        for voice_attempt, current_voice in enumerate([primary_voice] + fallback_voices):
            if voice_attempt > 0:
                print(f"[API /speak_question {client_host}] Trying fallback voice: {current_voice} (attempt {voice_attempt+1}/3)")
                # Create a new TTS instance with the fallback voice
                fallback_tts = EdgeTTS(voice=current_voice)
                tts_engine = fallback_tts
            else:
                tts_engine = tts  # Use the global instance for the first attempt
                
            try:
                # Call the modified tts.speak to save the file with timeout
                success = await asyncio.wait_for(
                    tts_engine.speak(question_text, output_filename=full_output_path),
                    timeout=request_timeout
                )
        
        if success:
                    # Verify the file actually exists and has content
                    if os.path.exists(full_output_path) and os.path.getsize(full_output_path) > 0:
                        elapsed = time.time() - start_time
                        print(f"[API /speak_question {client_host}] TTS audio generated successfully in {elapsed:.2f}s: {web_accessible_path}")
            return JSONResponse(content={
                "status": "success", 
                "message": "TTS audio generated.",
                "audio_url": web_accessible_path, # URL for the client to fetch/play
                            "original_text": question_text,
                            "voice_used": current_voice,
                            "generation_time_ms": int(elapsed * 1000)
                        })
                    else:
                        print(f"[API /speak_question {client_host}] TTS file missing or empty: {full_output_path}")
                        # If this is not the last voice to try, continue to next
                        if voice_attempt < len(fallback_voices):
                            print(f"[API /speak_question {client_host}] Will try next fallback voice.")
                            continue
                        
                        # Otherwise return an error
                        return JSONResponse(status_code=500, content={
                            "error": "TTS file missing or empty after generation.",
                            "fallback_text": question_text
            })
        else:
                    print(f"[API /speak_question {client_host}] TTS generation function returned False for: '{question_text[:50]}...'")
                    # If this is not the last voice to try, continue to next
                    if voice_attempt < len(fallback_voices):
                        print(f"[API /speak_question {client_host}] Will try next fallback voice.")
                        continue
                        
                    # Otherwise return an error
                    return JSONResponse(status_code=500, content={
                        "error": "TTS generation failed.",
                        "fallback_text": question_text
                    })
            except asyncio.TimeoutError:
                print(f"[API /speak_question {client_host}] TTS generation timed out after {request_timeout}s for: '{question_text[:50]}...'")
                # If this is not the last voice to try, continue to next
                if voice_attempt < len(fallback_voices):
                    print(f"[API /speak_question {client_host}] Will try next fallback voice.")
                    continue
                    
                # Otherwise return an error
                return JSONResponse(status_code=504, content={
                    "error": f"TTS generation timed out after {request_timeout} seconds with all voices.",
                    "fallback_text": question_text
                })
            except Exception as voice_error:
                print(f"[API /speak_question {client_host}] Error with voice {current_voice}: {str(voice_error)}")
                traceback.print_exc()
                # If this is not the last voice to try, continue to next
                if voice_attempt < len(fallback_voices):
                    print(f"[API /speak_question {client_host}] Will try next fallback voice.")
                    continue
                
                # Otherwise return an error
                return JSONResponse(status_code=500, content={
                    "error": f"TTS processing error with all voices: {str(voice_error)}",
                    "fallback_text": question_text
                })
                
        # If we get here, all voices failed
        print(f"[API /speak_question {client_host}] All TTS voices failed for: '{question_text[:50]}...'")
        return JSONResponse(status_code=500, content={
            "error": "All TTS voices failed.",
            "fallback_text": question_text
        })
            
    except asyncio.TimeoutError as e:
        print(f"[API /speak_question {client_host}] Request timed out: {str(e)}")
        return JSONResponse(status_code=504, content={
            "error": "Request timed out while parsing input.",
            "fallback_text": "Error processing text."
        })
    except json.JSONDecodeError as e:
        print(f"[API /speak_question {client_host}] JSON decode error: {str(e)}")
        return JSONResponse(status_code=400, content={
            "error": "Invalid JSON in request.",
            "fallback_text": "Error processing text."
        })
    except Exception as e:
        print(f"[API /speak_question {client_host}] Unexpected error: {str(e)}")
        import traceback
        traceback.print_exc()
        
        return JSONResponse(status_code=500, content={
            "error": f"Server error during TTS processing: {str(e)}",
            "fallback_text": request_body.get("question", "Error processing text") if 'request_body' in locals() else "Error processing text"
        })

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
