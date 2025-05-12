let mode = null;
let currentQuestionIndex = 0;
let interviewData = {
    questions: [],
    answers: [],
    followups: [],
    followupAnswers: []
};
let isInterviewComplete = false;
let mediaRecorder = null;
let audioStream = null;
let waitingForFollowupAnswer = false; // New flag to track if we're waiting for a follow-up answer
let fullMediaRecorder = null;
let fullRecordingBlobs = [];
let fullMediaStream = null;


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
    isInterviewComplete = false;
    waitingForFollowupAnswer = false;

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
    document.getElementById("customQuestionSection").style.display = "none";
    document.getElementById("interviewStatusSection").style.display = "block";

    // Show the progress tracker
    updateProgressTracker(1, questions.length);
    
    // ✅ Now start the interview
    await startInterviewWithWelcome();
};

async function startInterviewWithWelcome() {
    console.log("Starting interview with welcome...");

    try {
        await startVideoRecording();
        console.log("Attempting to speak welcome message...");
        await speakText("Hello, welcome to this interview!");
        console.log("Welcome message spoken.");

        const firstQuestion = interviewData.questions[currentQuestionIndex];
        document.getElementById("currentQuestion").textContent = firstQuestion;
        
        // Update question counter
        document.getElementById("questionCounter").textContent = `Question 1 of ${interviewData.questions.length}`;
        
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
    // If interview is already complete, show the transcript
    if (isInterviewComplete) {
        endInterview();
        return;
    }

    try {
        // Set up what text to display based on whether we're handling a follow-up
        let currentQuestionText;
        if (waitingForFollowupAnswer) {
            // We're waiting for an answer to a follow-up
            currentQuestionText = interviewData.followups[interviewData.followups.length - 1];
            document.getElementById("followup").style.display = "block";
            document.getElementById("followup").textContent = currentQuestionText;
            document.getElementById("currentQuestion").textContent = "Follow-up Question:";
        } else {
            // Regular question
            currentQuestionText = interviewData.questions[currentQuestionIndex];
            document.getElementById("currentQuestion").textContent = currentQuestionText;
            document.getElementById("followup").style.display = "none";
            
            // Update question counter and progress bar
            document.getElementById("questionCounter").textContent = 
                `Question ${currentQuestionIndex + 1} of ${interviewData.questions.length}`;
            updateProgressTracker(currentQuestionIndex + 1, interviewData.questions.length);
        }
        
        // Record the answer (for either regular question or follow-up)
        console.log(`Recording answer for: ${currentQuestionText}`);
        const audioBlob = await recordAudioWithSilenceDetection();
        const formData = new FormData();
        formData.append("file", audioBlob, "answer.wav");
        formData.append("is_followup", waitingForFollowupAnswer);  // 👈 add this


        // Show recording status
        document.getElementById("recordingStatus").textContent = "Processing your answer...";

        const res = await fetch("/answer", {
            method: "POST",
            body: formData
        });
        const data = await res.json();

        // Reset recording status
        document.getElementById("recordingStatus").textContent = "";

        // Check if the interview is complete
        if (data.interview_complete) {
            console.log("Interview complete flag received from server");
            isInterviewComplete = true;
            endInterview();
            return;
        }

        // Handle the transcribed answer
        if (waitingForFollowupAnswer) {
            // Store the answer to the follow-up
            interviewData.followupAnswers.push(data.transcript);
            addToTranscriptList("You (Follow-up response)", data.transcript);
            console.log("Stored follow-up answer:", data.transcript);
            
            // We've handled the follow-up, now move to the next question
            waitingForFollowupAnswer = false;
        }
            if (data.interview_complete) {
                console.log("Interview is complete after follow-up.");
                isInterviewComplete = true;
                endInterview();
                return;
            }
        
            
        else {
            // Store the answer to the regular question
            interviewData.answers.push(data.transcript);
            addToTranscriptList("You", data.transcript);
        }
        
        // Handle follow-up if there is one
        if (data.followup && !waitingForFollowupAnswer) {
            // Store the follow-up
            interviewData.followups.push(data.followup);
            
            // Show and speak the follow-up
            document.getElementById("followup").style.display = "block";
            document.getElementById("followup").textContent = data.followup;
            addToTranscriptList("Interviewer (Follow-up)", data.followup);
            await speakText(data.followup);
            
            // Set flag that we're now waiting for a follow-up answer
            waitingForFollowupAnswer = true;
            
            // Process the follow-up question (to get the answer)
            processNextQuestion();
            return;
        }

        // If we're here, we've handled any follow-ups and are ready to move to the next question
        if (data.next_question !== null && data.next_question !== undefined) {
            const previousIndex = currentQuestionIndex;
            currentQuestionIndex = data.next_question;
            
            console.log(`Moving from question #${previousIndex + 1} to #${currentQuestionIndex + 1}`);
            
            // Check if we're moving beyond available questions
            if (currentQuestionIndex >= interviewData.questions.length) {
                console.log("No more questions available. Ending interview.");
                isInterviewComplete = true;
                endInterview();
                return;
            }
            
            // Process the next regular question
            const nextQuestion = interviewData.questions[currentQuestionIndex];
            if (nextQuestion) {
                document.getElementById("currentQuestion").textContent = nextQuestion;
                addToTranscriptList("Interviewer", nextQuestion);
                await speakText(nextQuestion);
                processNextQuestion();
            } else {
                console.log("No next question found. Ending interview.");
                isInterviewComplete = true;
                endInterview();
            }
        } else {
            console.log("No next_question index received. Ending interview.");
            isInterviewComplete = true;
            endInterview();
        }
    } catch (error) {
        console.error("Error processing question:", error);
        document.getElementById("recordingStatus").textContent = "Error: " + error.message;
    }
}

function updateProgressTracker(current, total) {
    const progressBar = document.getElementById("progressBar");
    const progress = (current / total) * 100;
    progressBar.style.width = `${progress}%`;
    
    // Update question counter
    document.getElementById("questionCounter").textContent = `Question ${current} of ${total}`;
}

function addToTranscriptList(speaker, text) {
    const ongoingTranscript = document.getElementById("ongoingTranscript");
    const entryElement = document.createElement("div");
    entryElement.className = "transcript-entry";
    
    const speakerElement = document.createElement("span");
    speakerElement.className = "transcript-speaker";
    speakerElement.textContent = speaker + ": ";
    
    const textElement = document.createElement("span");
    textElement.className = "transcript-text";
    textElement.textContent = text;
    
    entryElement.appendChild(speakerElement);
    entryElement.appendChild(textElement);
    ongoingTranscript.appendChild(entryElement);
    
    // Scroll to bottom
    ongoingTranscript.scrollTop = ongoingTranscript.scrollHeight;
}

function endInterview() {
    console.log("Ending interview and showing complete transcript");
    document.getElementById("liveVideo").style.display = "none";


    // Stop audio recording (if it exists)
    if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
    }

    // ✅ Always stop + show video playback
    stopAndShowRecording();

    // Tell the server to officially end the interview
    fetch("/end_interview", {
        method: "POST"
    });

    // Hide interview section
    document.getElementById("interviewStatusSection").style.display = "none";

    // Show complete container
    document.getElementById("complete-container").style.display = "block";

    // Display full transcript
    displayFullTranscript();
}


function displayFullTranscript() {
    const transcriptContainer = document.getElementById("fullTranscript");
    transcriptContainer.innerHTML = ""; // Clear existing content
    
    // Add a header
    const headerElement = document.createElement("h3");
    headerElement.textContent = "Complete Interview Transcript";
    transcriptContainer.appendChild(headerElement);
    
    // Get transcript from API to ensure we have the complete one
    fetch("/transcript")
        .then(response => response.json())
        .then(data => {
            // Check if there's an official transcript
            if (data.transcript && data.transcript.length > 0) {
                data.transcript.forEach(entry => {
                    const entryElement = document.createElement("p");
                    entryElement.className = entry.speaker === "AI" ? "interviewer" : "interviewee";
                    
                    const speakerLabel = entry.speaker === "AI" ? "Interviewer: " : "You: ";
                    entryElement.textContent = speakerLabel + entry.text;
                    
                    transcriptContainer.appendChild(entryElement);
                });
            } else {
                // Fallback to local data if server doesn't have transcript
                // Process main questions and answers
                interviewData.questions.forEach((question, index) => {
                    const questionElement = document.createElement("p");
                    questionElement.className = "interviewer";
                    questionElement.textContent = `Interviewer: ${question}`;
                    transcriptContainer.appendChild(questionElement);

                    if (interviewData.answers[index]) {
                        const answerElement = document.createElement("p");
                        answerElement.className = "interviewee";
                        answerElement.textContent = `You: ${interviewData.answers[index]}`;
                        transcriptContainer.appendChild(answerElement);
                    }

                    // Add follow-up and its answer if available for this question
                    if (interviewData.followups[index]) {
                        const followupElement = document.createElement("p");
                        followupElement.className = "interviewer followup";
                        followupElement.textContent = `Interviewer (Follow-up): ${interviewData.followups[index]}`;
                        transcriptContainer.appendChild(followupElement);
                        
                        // Add follow-up answer if available
                        if (interviewData.followupAnswers[index]) {
                            const followupAnswerElement = document.createElement("p");
                            followupAnswerElement.className = "interviewee followup-answer";
                            followupAnswerElement.textContent = `You: ${interviewData.followupAnswers[index]}`;
                            transcriptContainer.appendChild(followupAnswerElement);
                        }
                    }
                });
            }
            
            // Add download transcript button
            const downloadButton = document.createElement("button");
            downloadButton.id = "downloadTranscript";
            downloadButton.textContent = "Download Transcript";
            downloadButton.className = "action-button";
            downloadButton.onclick = downloadTranscriptAsText;
            transcriptContainer.appendChild(downloadButton);
            
            // Add restart button
            const restartButton = document.createElement("button");
            restartButton.id = "restartInterview";
            restartButton.textContent = "Start New Interview";
            restartButton.className = "action-button primary";
            restartButton.onclick = () => location.reload();
            transcriptContainer.appendChild(restartButton);
        })
        .catch(error => {
            console.error("Error fetching transcript:", error);
            // Display a basic error message
            const errorElement = document.createElement("p");
            errorElement.textContent = "Error loading transcript. Please try again.";
            errorElement.style.color = "red";
            transcriptContainer.appendChild(errorElement);
        });
}

function downloadTranscriptAsText() {
    let transcriptText = "INTERVIEW TRANSCRIPT\n\n";
    
    // Get all transcript entries
    const transcriptEntries = document.querySelectorAll("#fullTranscript p");
    transcriptEntries.forEach(entry => {
        transcriptText += entry.textContent + "\n\n";
    });
    
    // Create a blob and download link
    const blob = new Blob([transcriptText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "interview_transcript.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function recordAudioWithSilenceDetection() {
    return new Promise(async (resolve) => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioStream = stream; // Store stream globally so we can stop it later
        
        mediaRecorder = new MediaRecorder(stream);
        const chunks = [];
        let silenceTimer = null;
        let lastAudioLevel = 0;
        let silenceDetected = false;
        
        // Set up audio analyzer to detect silence
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);
        const analyzer = audioContext.createAnalyser();
        analyzer.fftSize = 256;
        source.connect(analyzer);
        
        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        let silentCount = 0;
        
        // Function to detect silence
        function checkForSilence() {
            analyzer.getByteFrequencyData(dataArray);
            
            // Calculate average audio level
            const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
            
            // Update recording status with audio level
            document.getElementById("recordingStatus").textContent = 
                `Recording... ${Math.round(average)}`;
            
            // Check for silence (low audio level)
            if (average < 10) {
                silentCount++;
                
                // If silence for more than 3 seconds (180 frames at ~60fps)
                if (silentCount > 180) {
                    console.log("Silence detected. Stopping recording.");
                    document.getElementById("recordingStatus").textContent = 
                        "Silence detected. Processing...";
                    
                    silenceDetected = true;
                    mediaRecorder.stop();
                    clearInterval(silenceCheckInterval);
                }
            } else {
                silentCount = 0;
                lastAudioLevel = average;
            }
        }
        
        // Start checking for silence
        const silenceCheckInterval = setInterval(checkForSilence, 16);
        
        mediaRecorder.ondataavailable = e => chunks.push(e.data);
        
        mediaRecorder.onstop = () => {
            clearInterval(silenceCheckInterval);
            audioContext.close();
            
            // Stop all tracks
            stream.getTracks().forEach(track => track.stop());
            
            resolve(new Blob(chunks, { type: 'audio/wav' }));
        };
        
        // Start recording
        document.getElementById("recordingStatus").textContent = "Recording...";
        mediaRecorder.start();
        
        // Also set a maximum recording time (60 seconds)
        setTimeout(() => {
            if (!silenceDetected && mediaRecorder.state !== 'inactive') {
                console.log("Max recording time reached. Stopping recording.");
                document.getElementById("recordingStatus").textContent = 
                    "Max time reached. Processing...";
                mediaRecorder.stop();
            }
        }, 60000);
    });
}

async function startVideoRecording() {
    try {
        fullMediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

        // Show the webcam on screen
        const videoElement = document.getElementById("liveVideo");
        videoElement.srcObject = fullMediaStream;
        videoElement.play();

        // Record audio+video
        fullRecordingBlobs = [];
        fullMediaRecorder = new MediaRecorder(fullMediaStream);

        fullMediaRecorder.ondataavailable = (e) => {
            console.log("Got video data:", e.data);  // ✅ Debug log
            if (e.data.size > 0) fullRecordingBlobs.push(e.data);
        };

        fullMediaRecorder.start(1000);  // ✅ Flush chunks every second
    } catch (err) {
        console.error("Failed to start video recording:", err);
    }
}
function stopAndShowRecording() {
    console.log("Blobs:", fullRecordingBlobs);
    if (fullMediaRecorder && fullMediaRecorder.state !== "inactive") {
        fullMediaRecorder.stop();
    }

    if (fullMediaStream) {
        fullMediaStream.getTracks().forEach(track => track.stop());
    }

    const playbackBlob = new Blob(fullRecordingBlobs, { type: 'video/webm' });
    const playbackURL = URL.createObjectURL(playbackBlob);

    const videoPlayer = document.createElement("video");
    videoPlayer.controls = true;
    videoPlayer.src = playbackURL;
    videoPlayer.style.width = "100%";
    videoPlayer.style.marginTop = "20px";

    document.getElementById("complete-container").appendChild(videoPlayer);
}
