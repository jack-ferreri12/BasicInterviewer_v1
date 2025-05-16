from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from interview_logic.TTS.edge_tts_engine import EdgeTTS
from interview_logic.STT.whisper_stt import WhisperSTT
import tempfile, shutil, os
import requests
import json

app = FastAPI()
app.mount("/static", StaticFiles(directory="app/static"), name="static")

stt = WhisperSTT()
tts = EdgeTTS()

# Shared state across requests
state = {
    "mode": None,
    "questions": [],
    "index": 0,
    "is_interview_complete": False
}

@app.get("/")
def serve_home():
    return FileResponse("app/static/index.html")

@app.get("/start")
async def start_interview(mode: str):
    state["mode"] = mode
    state["index"] = 0
    state["questions"] = [{"question": "What is your greatest strength?"}] if mode == "preset" else []
    state["transcript"] = []
    state["is_interview_complete"] = False

    first_q = state["questions"][0]["question"] if mode == "preset" else "Please input your first custom question."
    await tts.speak(first_q)
    return {"question": first_q}

@app.post("/submit_custom_question")
async def add_custom_question(request: Request):
    data = await request.json()
    q_text = data.get("question")
    if q_text:
        state["questions"].append({"question": q_text})
    return {"ok": True}

@app.post("/answer")
async def submit_answer(
    request: Request,
    file: UploadFile = File(...),
    is_followup: bool = Form(False)
):
    print("[API] /answer endpoint hit ✅")

    if state.get("is_interview_complete", False):
        print("[API] Interview already marked complete. Ignoring input.")
        return {
            "interview_complete": True,
            "transcript": state.get("transcript", []),
            "followup": None,
            "next_question": None
        }

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            shutil.copyfileobj(file.file, tmp)
            audio_path = tmp.name

        print("[API] Transcribing...")
        transcript_text = stt.transcribe(audio_path)
        os.remove(audio_path)

        current_index = state["index"]
        print(f"[API] current_index: {current_index} (Question #{current_index + 1})")
        print("[API] state['questions']:", state["questions"])

        if not state["questions"]:
            print("[API] ❌ No questions available!")
            state["is_interview_complete"] = True
            return {
                "interview_complete": True,
                "transcript": state.get("transcript", []),
                "followup": None,
                "next_question": None
            }
        
        if current_index >= len(state["questions"]):
            print(f"[API] Index {current_index} is beyond available questions. Ending interview.")
            state["is_interview_complete"] = True
            return {
                "interview_complete": True,
                "transcript": state.get("transcript", []),
                "followup": None,
                "next_question": None
            }

        current_question = state["questions"][current_index]["question"]

        if "transcript" not in state:
            state["transcript"] = []

        # Add human response to transcript
        if is_followup:
            # If this is a follow-up answer, just add the human response
            state["transcript"].append({"speaker": "Human", "text": transcript_text, "is_followup_answer": True})
        else:
            # For regular questions, add both the question and answer to transcript
            state["transcript"].append({"speaker": "AI", "text": current_question, "question_number": current_index + 1})
            state["transcript"].append({"speaker": "Human", "text": transcript_text})

        payload = {
            "questions": [q["question"] for q in state["questions"]],
            "current_question": current_index + 1,  # 1-based index for the LLM
            "transcript": state["transcript"]
        }

        print(f"[API] Sending webhook for question #{current_index + 1}: {current_question}")
        webhook_url = "https://hudmarr.app.n8n.cloud/webhook/fb613c07-aa88-4fbd-a3c9-ba4cdf7387a9"
        response = requests.post(webhook_url, json=payload, timeout=10)
        print(f"[API] Webhook response:", response.text)

        data = response.json()
        
        if "output" not in data:
            print("[API] No output in webhook response")
            return {
                "error": "No output in webhook response",
                "transcript": transcript_text,
                "followup": None,
                "next_question": current_index
            }

        parsed_output = json.loads(data["output"])
        print("[API] Extracted from output:", parsed_output)

        # Get the values from the parsed output
        is_follow_up = parsed_output.get("is_follow_up", False)
        next_response = parsed_output.get("response")

        if next_response is None:
            print("[API] No response in webhook output")
            return {
                "error": "No response in webhook output",
                "transcript": transcript_text,
                "followup": None,
                "next_question": current_index
            }

        # Process based on whether this is a follow-up or next question
        if is_follow_up:
            print(f"[API] Handling follow-up question: {next_response}")
            # Add follow-up to transcript
            state["transcript"].append({"speaker": "AI", "text": next_response, "is_followup": True})
            
            # Return follow-up information, staying on same question
            return {
                "transcript": transcript_text,
                "followup": next_response,
                "next_question": current_index,
                "is_follow_up": True,
                "interview_complete": False,
                "question_number": current_index + 1  # 1-based for display
            }
        else:
            # This is NOT a follow-up, move to next question
            print(f"[API] Moving to next question after response: {next_response}")
            
            # Increment the question index 
            next_index = current_index + 1
            state["index"] = next_index
            
            # Add transition response to transcript
            state["transcript"].append({"speaker": "AI", "text": next_response, "transition_to": next_index + 1})
            
            # Check if we've reached the end of questions
            if next_index >= len(state["questions"]):
                print("[API] No more questions. Ending interview.")
                state["is_interview_complete"] = True
                return {
                    "transcript": transcript_text,
                    "followup": next_response,
                    "next_question": None,
                    "is_follow_up": False,
                    "interview_complete": True,
                    "question_number": current_index + 1  # The question we just finished
                }
            
            # Return next question information
            next_question_text = state["questions"][next_index]["question"]
            return {
                "transcript": transcript_text,
                "followup": next_response,
                "next_question": next_index,
                "next_question_text": next_question_text,
                "is_follow_up": False,
                "interview_complete": False,
                "question_number": next_index + 1  # 1-based for display
            }

    except Exception as e:
        print("[API ERROR]", str(e))
        return {
            "error": str(e),
            "transcript": "Error",
            "followup": None,
            "next_question": None
        }


@app.post("/speak_question")
async def speak_question(request: Request):
    data = await request.json()
    question = data.get("question")
    if question:
        await tts.speak(question)
    return {"status": "success"}

@app.get("/popular")
def serve_popular_page():
    return FileResponse("app/static/popular.html")


@app.get("/load_preset/{preset_id}")
def load_preset(preset_id: str):
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
        "google": [
            "How do you approach system design under scale?",
            "Explain a project you're proud of and your role in it.",
            "What's the hardest bug you've debugged?"
        ],
        "starbucks": [
            "How would you handle a rush with multiple upset customers?",
            "Describe your ideal team environment.",
            "What does good customer service mean to you?"
        ],
        "tesla": [
            "Describe a time you solved a tough engineering problem.",
            "How do you deal with frequent iteration under pressure?",
            "Why do you want to work at Tesla?"
        ],
        "target": [
            "How do you lead a team with mixed experience levels?",
            "Describe a time you had to hit a goal under a deadline.",
            "How do you respond to employee conflict?"
        ]
    }

    questions = presets.get(preset_id)
    if not questions:
        return JSONResponse(status_code=404, content={"error": "Preset not found."})
    
    return {"questions": questions}


@app.get("/transcript")
def get_transcript():
    """Return the full transcript with enhanced metadata"""
    # Enhance the transcript with additional metadata
    enhanced_transcript = []
    
    for i, entry in enumerate(state.get("transcript", [])):
        # Create a copy of the entry with all its fields
        enhanced_entry = entry.copy()
        
        # If this is a question, add the question number
        if entry.get("speaker") == "AI" and not entry.get("is_followup") and not entry.get("transition_to"):
            question_idx = 0
            for j in range(i):
                if state["transcript"][j].get("speaker") == "AI" and not state["transcript"][j].get("is_followup") and not state["transcript"][j].get("transition_to"):
                    question_idx += 1
            enhanced_entry["question_number"] = question_idx + 1
        
        enhanced_transcript.append(enhanced_entry)
    
    return JSONResponse(content={
        "transcript": enhanced_transcript,
        "questions": state.get("questions", []),
        "is_complete": state.get("is_interview_complete", False)
    })

@app.post("/end_interview")
def end_interview():
    state["is_interview_complete"] = True
    return {"status": "success", "message": "Interview marked as complete"}
