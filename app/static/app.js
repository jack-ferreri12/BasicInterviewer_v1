let mode = null;
let currentQuestionIndex = 0;
let interviewData = {
    questions: [],
    answers: [],
    followups: [],
};

// Handle custom interview mode selection
document.getElementById("startCustom").onclick = () => {
    console.log("Start Custom clicked");
    document.getElementById("customQuestionSection").style.display = "block";
    document.getElementById("startCustom").disabled = true;
    addQuestionInput();
};

// Add a new question input field
document.getElementById("addQuestionBtn").onclick = () => {
    console.log("Add Question clicked");
    addQuestionInput();
};

function addQuestionInput() {
    const questionContainer = document.getElementById("questionContainer");
    const newQuestionBox = document.createElement("div");
    newQuestionBox.classList.add("questionBox");
    newQuestionBox.innerHTML = `
        <input type="text" class="questionInput" placeholder="Enter your question here" />
    `;
    questionContainer.appendChild(newQuestionBox);

    document.getElementById("startInterview").style.display = "inline-block";
    document.getElementById("startInterview").disabled = false;
}

document.getElementById("startInterview").onclick = async () => {
    console.log("Start Interview clicked");

    const questions = Array.from(document.querySelectorAll(".questionInput")).map(input => input.value.trim());
    if (questions.length === 0) {
        alert("Please add at least one question.");
        return;
    }

    interviewData.questions = questions;
    currentQuestionIndex = 0;

    // ✅ Submit each question to the backend before starting
    for (const q of questions) {
        console.log("Submitting question to backend:", q);
        await fetch("/submit_custom_question", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: q }),
        });
    }

    document.getElementById("startInterview").style.display = "none";

    // ✅ Now start the interview
    await startInterviewWithWelcome();
};

async function startInterviewWithWelcome() {
    console.log("Starting interview with welcome...");

    try {
        console.log("Attempting to speak welcome message...");
        await speakText("Hello, welcome to this interview!");
        console.log("Welcome message spoken.");

        const firstQuestion = interviewData.questions[currentQuestionIndex];
        document.getElementById("currentQuestion").textContent = firstQuestion;

        await speakText(firstQuestion);
        console.log("First question spoken: " + firstQuestion);

        processNextQuestion();
    } catch (error) {
        console.error("Error during TTS:", error);
    }
}

async function speakText(text) {
    const response = await fetch("/speak_question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
    });

    const data = await response.json();
    if (data.status === "success") {
        console.log("Text spoken successfully");
    } else {
        console.error("Failed to speak text:", data);
    }
}

async function processNextQuestion() {
    const currentQuestion = interviewData.questions[currentQuestionIndex];
    document.getElementById("currentQuestion").textContent = currentQuestion;

    const audioBlob = await recordAudio();
    const formData = new FormData();
    formData.append("file", audioBlob, "answer.wav");

    const res = await fetch("/answer", {
        method: "POST",
        body: formData
    });
    const data = await res.json();

    interviewData.answers.push(data.transcript);
    interviewData.followups.push(data.followup);

    if (data.followup) {
        document.getElementById("followup").style.display = "block";
        document.getElementById("followup").textContent = data.followup;
        await speakText(data.followup);
    } else {
        document.getElementById("followup").style.display = "none";
    }

    if (data.next_question !== null) {
        currentQuestionIndex = data.next_question;
        const nextQuestion = interviewData.questions[currentQuestionIndex] || data.followup;
        if (nextQuestion) {
            interviewData.questions.push(nextQuestion);
            document.getElementById("currentQuestion").textContent = nextQuestion;
            await speakText(nextQuestion);
            processNextQuestion();
        } else {
            document.getElementById("complete-container").style.display = "block";
            displayFullTranscript();
        }
    } else {
        document.getElementById("complete-container").style.display = "block";
        displayFullTranscript();
    }
}

function displayFullTranscript() {
    const transcriptContainer = document.getElementById("fullTranscript");
    interviewData.questions.forEach((question, index) => {
        const questionElement = document.createElement("p");
        questionElement.textContent = `Interviewer: ${question}`;
        transcriptContainer.appendChild(questionElement);

        const answerElement = document.createElement("p");
        answerElement.textContent = `Interviewee: ${interviewData.answers[index]}`;
        transcriptContainer.appendChild(answerElement);

        if (interviewData.followups[index]) {
            const followupElement = document.createElement("p");
            followupElement.textContent = `Follow-up: ${interviewData.followups[index]}`;
            transcriptContainer.appendChild(followupElement);
        }
    });
}

function recordAudio() {
    return new Promise(async (resolve) => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        const chunks = [];

        mediaRecorder.ondataavailable = e => chunks.push(e.data);
        mediaRecorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/wav' }));

        mediaRecorder.start();
        setTimeout(() => mediaRecorder.stop(), 5000);
    });
}
