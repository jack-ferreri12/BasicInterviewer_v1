let mode = null;
let currentQuestionIndex = 0;
let interviewData = {
    questions: [],
    answers: [],
    followups: [],
};

// Handle custom interview mode selection
document.getElementById("startCustom").onclick = () => {
    console.log("Start Custom clicked"); // Debugging line
    document.getElementById("customQuestionSection").style.display = "block"; // Show the custom question section
    document.getElementById("startCustom").disabled = true; // Disable the button to prevent re-clicking
    addQuestionInput(); // Add one input by default
};

// Add a new question input field
document.getElementById("addQuestionBtn").onclick = () => {
    console.log("Add Question clicked"); // Debugging line
    addQuestionInput();
};

// Function to create a new input field for questions
function addQuestionInput() {
    const questionContainer = document.getElementById("questionContainer");
    const newQuestionBox = document.createElement("div");
    newQuestionBox.classList.add("questionBox");
    newQuestionBox.innerHTML = `
        <input type="text" class="questionInput" placeholder="Enter your question here" />
    `;
    questionContainer.appendChild(newQuestionBox);

    // Enable the "Start Interview" button once at least one question is added
    document.getElementById("startInterview").style.display = "inline-block";
    document.getElementById("startInterview").disabled = false;
}

document.getElementById("startInterview").onclick = async () => {
    console.log("Start Interview clicked");  // Debugging line
    const questions = Array.from(document.querySelectorAll(".questionInput")).map(input => input.value.trim());
    if (questions.length === 0) {
        alert("Please add at least one question.");
        return;
    }

    interviewData.questions = questions;
    currentQuestionIndex = 0;
    document.getElementById("startInterview").style.display = "none"; // Hide the start button
    await startInterviewWithWelcome(); // Start interview with a welcome message
};

// Function to start the interview and say a welcome message
async function startInterviewWithWelcome() {
    console.log("Starting interview with welcome...");

    // First, the interviewer speaks the welcome message
    try {
        console.log("Attempting to speak welcome message...");
        await speakText("Hello, welcome to this interview!");

        console.log("Welcome message spoken.");

        // After the welcome message, ask the first custom question
        const firstQuestion = interviewData.questions[currentQuestionIndex];
        document.getElementById("currentQuestion").textContent = firstQuestion;

        // Send the first question to the backend to be spoken aloud
        await speakText(firstQuestion);
        console.log("First question spoken: " + firstQuestion);

        // Send the first question's transcript to n8n
        await sendToN8N(firstQuestion);  // Send the question's transcript to n8n

        // Continue to process the next question
        processNextQuestion();
    } catch (error) {
        console.error("Error during TTS:", error);
    }
}

// Helper function to call the backend TTS API for speaking the question
async function speakText(text) {
    const response = await fetch("/speak_question", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: text }),
    });

    const data = await response.json();
    if (data.status === "success") {
        console.log("Text spoken successfully");
    } else {
        console.error("Failed to speak text:", data);
    }
}

// Function to send the first question's transcript to n8n
async function sendToN8N(transcript) {
    try {
        const response = await fetch("/n8n-webhook", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                transcript: transcript,  // Send the question's text to n8n
            }),
        });

        const data = await response.json();
        console.log("Webhook sent to n8n:", data);
    } catch (error) {
        console.error("Error sending webhook to n8n:", error);
    }
}

async function processNextQuestion() {
    const currentQuestion = interviewData.questions[currentQuestionIndex];
    document.getElementById("currentQuestion").textContent = currentQuestion;

    // Simulate recording answer and handling follow-up (you can replace this with actual functionality)
    const audioBlob = await recordAudio(); // Record audio (replace with actual function)
    const formData = new FormData();
    formData.append("file", audioBlob, "answer.wav");

    const res = await fetch("/answer", {
        method: "POST",
        body: formData
    });
    const data = await res.json();

    interviewData.answers.push(data.transcript); // Store the answer
    interviewData.followups.push(data.followup); // Store follow-up if any

    if (data.followup) {
        document.getElementById("followup").style.display = "block";
        document.getElementById("followup").textContent = data.followup;
    } else {
        document.getElementById("followup").style.display = "none";
        if (currentQuestionIndex + 1 < interviewData.questions.length) {
            currentQuestionIndex++;
            processNextQuestion();
        } else {
            document.getElementById("complete-container").style.display = "block";
            displayFullTranscript();
        }
    }
}

// Function to display full transcript after the interview
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
        setTimeout(() => mediaRecorder.stop(), 5000);  // auto stop after 5 seconds
    });
}
