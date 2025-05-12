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

        current_question = state["questions"][current_index]["question"]

        if "transcript" not in state:
            state["transcript"] = []

        if not is_followup:
            state["transcript"].append({"speaker": "AI", "text": current_question})

        state["transcript"].append({"speaker": "Human", "text": transcript_text})

        payload = {
            "questions": [q["question"] for q in state["questions"]],
            "current_question": current_index + 1,
            "transcript": state["transcript"]
        }

        print(f"[API] Sending webhook for question #{current_index + 1}: {current_question}")
        webhook_url = "https://hudmarr.app.n8n.cloud/webhook/fb613c07-aa88-4fbd-a3c9-ba4cdf7387a9"
        response = requests.post(webhook_url, json=payload, timeout=10)
        print(f"[API] Webhook response:", response.text)

        data = response.json()
        next_q = None

        if "output" in data:
            parsed_output = json.loads(data["output"])
            print("[API] Extracted from output:", parsed_output)

            next_index = parsed_output.get("current_question", current_index + 1)
            next_q = parsed_output.get("response")

            if not is_followup and next_index != current_index:
                print(f"[API] Advancing to question #{next_index}")
                state["index"] = next_index

            # Handle follow-up for last question
            if next_index >= len(state["questions"]):
                if next_q:
                    print(f"[API] Follow-up for last question: {next_q}")
                    return {
                        "transcript": transcript_text,
                        "followup": next_q,
                        "next_question": current_index,
                        "interview_complete": False
                    }
                else:
                    print("[API] End of interview reached.")
                    state["is_interview_complete"] = True
                    return {
                        "interview_complete": True,
                        "transcript": state["transcript"],
                        "followup": None,
                        "next_question": None
                    }
        else:
            if not is_followup:
                state["index"] = current_index + 1

        # 🧠 If this was a follow-up AND there are no more core questions, mark done
        if is_followup and current_index + 1 >= len(state["questions"]):
            print("[API] Interview completed after final follow-up.")
            state["is_interview_complete"] = True
            return {
                "transcript": transcript_text,
                "followup": None,
                "next_question": None,
                "interview_complete": True
            }

        if next_q:
            print(f"[API] Handling follow-up question: {next_q}")
            return {
                "transcript": transcript_text,
                "followup": next_q,
                "next_question": current_index,
                "interview_complete": False
            }

        return {
            "transcript": transcript_text,
            "followup": None,
            "next_question": state["index"],
            "interview_complete": state["is_interview_complete"]
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

@app.get("/transcript")
def get_transcript():
    return JSONResponse(content={
        "transcript": state.get("transcript", []),
        "is_complete": state.get("is_interview_complete", False)
    })

@app.post("/end_interview")
def end_interview():
    state["is_interview_complete"] = True
    return {"status": "success", "message": "Interview marked as complete"}
