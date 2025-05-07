from fastapi import FastAPI, UploadFile, File, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from interview_logic.TTS.edge_tts_engine import EdgeTTS
from interview_logic.STT.whisper_stt import WhisperSTT
import tempfile, shutil, os
import requests

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

    first_q = state["questions"][0]["question"] if mode == "preset" else "Please input your first custom question."
    await tts.speak(first_q)  # Make sure the first question is spoken
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
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
        shutil.copyfileobj(file.file, tmp)
        audio_path = tmp.name

    # Transcribe the answer using Whisper
    transcript = stt.transcribe(audio_path)
    os.remove(audio_path)

    # Sending the transcript to an n8n webhook
    webhook_url = "https://jack-ferreri.app.n8n.cloud/webhook-test/470d06b9-37ad-4984-8b8c-5d01bcbf93c0"  # Replace with your n8n webhook URL
    response = requests.post(webhook_url, json={"transcript": transcript})

    return {"transcript": transcript, "followup": None, "next_question": None}

@app.post("/speak_question")
async def speak_question(request: Request):
    """Endpoint to speak the current question."""
    data = await request.json()
    question = data.get("question")
    if question:
        await tts.speak(question)  # Make sure the question is spoken out loud
    return {"status": "success"}

@app.post("/n8n-webhook")
async def handle_n8n_webhook(request: Request):
    data = await request.json()
    transcript = data.get("transcript")
    
    if transcript:
        # Send the transcript to n8n via a webhook
        webhook_url = "https://your-n8n-webhook-url"  # Replace with your n8n webhook URL
        response = requests.post(webhook_url, json={"transcript": transcript})
        
        return {"status": "success", "message": "Webhook sent to n8n"}
    
    return {"status": "error", "message": "No transcript found"}
