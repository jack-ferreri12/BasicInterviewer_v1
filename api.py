from fastapi import FastAPI, UploadFile, File, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from interview_logic.TTS.edge_tts_engine import EdgeTTS
from interview_logic.STT.whisper_stt import WhisperSTT
import tempfile, shutil, os
import requests
import json  # ✅ needed for json.loads()

app = FastAPI()
app.mount("/static", StaticFiles(directory="app/static"), name="static")

stt = WhisperSTT()
tts = EdgeTTS()

# Shared state across requests
state = {
    "mode": None,
    "questions": [],
    "index": 0
}

@app.get("/")
def serve_home():
    return FileResponse("app/static/index.html")

@app.get("/start")
async def start_interview(mode: str):
    state["mode"] = mode
    state["index"] = 0
    state["questions"] = [{"question": "What is your greatest strength?"}] if mode == "preset" else []
    state["transcript"] = []  # Reset transcript too

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
async def submit_answer(file: UploadFile = File(...)):
    print("[API] /answer endpoint hit ✅")

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            shutil.copyfileobj(file.file, tmp)
            audio_path = tmp.name

        print("[API] Transcribing...")
        transcript_text = stt.transcribe(audio_path)
        os.remove(audio_path)

        current_index = state["index"]
        print("[API] current_index:", current_index)
        print("[API] state['questions']:", state["questions"])

        if not state["questions"] or current_index >= len(state["questions"]):
            print("[API] ❌ No current question available!")
            return {
                "error": "No current question available.",
                "transcript": transcript_text,
                "followup": None,
                "next_question": None
            }

        current_question = state["questions"][current_index]["question"]

        if "transcript" not in state:
            state["transcript"] = []
        state["transcript"].append({"speaker": "AI", "text": current_question})
        state["transcript"].append({"speaker": "Human", "text": transcript_text})

        payload = {
            "questions": [q["question"] for q in state["questions"]],
            "current_question": current_index + 1,
            "transcript": state["transcript"]
        }

        print("[API] Sending payload to n8n:", payload)
        webhook_url = "https://hudmarr.app.n8n.cloud/webhook/fb613c07-aa88-4fbd-a3c9-ba4cdf7387a9"
        response = requests.post(webhook_url, json=payload, timeout=10)
        print("[API] POST to n8n sent")
        print("[API] n8n raw response:", response.text)

        data = response.json()
        print("[API] Parsed JSON from n8n:", data)

        # ✅ Handle the double-encoded "output" field
        if "output" in data:
            parsed_output = json.loads(data["output"])
            print("[API] Extracted from output:", parsed_output)

            state["index"] = parsed_output.get("current_question", current_index + 1)
            next_q = parsed_output.get("response")
        else:
            state["index"] = current_index + 1
            next_q = None

        if next_q:
            state["questions"].append({"question": next_q})

        return {
            "transcript": transcript_text,
            "followup": next_q,
            "next_question": state["index"]
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
