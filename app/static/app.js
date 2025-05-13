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






// Simplified showClosingRemarks function
function showClosingRemarks(text) {
    // Clear current question display
    document.getElementById("currentQuestion").textContent = "";
    document.getElementById("followup").style.display = "none";
    
    // Add closing remarks container
    const questionContainer = document.querySelector(".question-container");
    questionContainer.classList.add("closing");
    
    // Create closing remarks element
    const closingElement = document.createElement("div");
    closingElement.className = "closing-remarks";
    closingElement.innerHTML = `
        <div class="closing-indicator">Closing Remarks</div>
        <div class="closing-text">${text}</div>
        <div class="closing-countdown">Finishing up interview...</div>
    `;
    
    // Replace current content with closing remarks
    questionContainer.appendChild(closingElement);
    
    // Update progress bar to 100%
    const progressBar = document.getElementById("progressBar");
    progressBar.style.width = "100%";
    
    // Update question counter text
    document.getElementById("questionCounter").textContent = "Interview Complete";
}

// Main function for handling the interview flow - simplified to use is_follow_up flag
// Direct and focused solution to fix both issues:
// 1. No more repeated questions
// 2. No gap between speaking and recording

// Back to basics with extensive debugging
// Core speakText function - simple and direct
// Fix for duplicate audio issue

// First, add this small helper function to the top of app.js to track if audio is already playing
// This will prevent duplicate audio requests
// Simple and reliable speakText function - no duplicate protection to start with
// Extremely basic speakText function - just makes the request and returns
// Debugging version of speakText with detailed logging
// Fix for double audio and transition+question issues

// 1. Track the last played audio to prevent duplicates
let lastPlayedAudio = "";

// 2. Simple speakText function with duplicate prevention
function speakText(text, source = "unknown") {
    // Skip if this is the same text we just played (within last 5 seconds)
    if (text === lastPlayedAudio) {
        console.log(`SKIPPING DUPLICATE AUDIO: "${text}"`);
        return Promise.resolve();
    }
    
    // Otherwise, play it and remember it
    console.log(`PLAYING AUDIO from ${source}: "${text}"`);
    lastPlayedAudio = text;
    
    // Clear the last played audio after 5 seconds
    setTimeout(() => {
        if (lastPlayedAudio === text) {
            lastPlayedAudio = "";
        }
    }, 5000);
    
    // Make the request
    return fetch("/speak_question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
    })
    .catch(error => {
        console.error("Audio request error:", error);
    });
}

// 3. Handle welcome message only once
let welcomeMessagePlayed = false;

// 4. Completely rewritten processNextQuestion
function processNextQuestion() {
    console.log("Running processNextQuestion");
    
    // Check if interview is already complete
    if (isInterviewComplete) {
        endInterview();
        return;
    }

    // Get current question
    let currentQuestionText;
    let isFollowUp = waitingForFollowupAnswer;
    
    if (isFollowUp) {
        // Handle follow-up question
        currentQuestionText = interviewData.followups[interviewData.followups.length - 1];
        document.getElementById("followup").style.display = "block";
        document.getElementById("followup").textContent = currentQuestionText;
        document.getElementById("currentQuestion").textContent = "Follow-up Question:";
    } else {
        // Handle regular question
        currentQuestionText = interviewData.questions[currentQuestionIndex];
        if (typeof currentQuestionText === 'object') {
            currentQuestionText = currentQuestionText.question;
        }
        document.getElementById("currentQuestion").textContent = currentQuestionText;
        document.getElementById("followup").style.display = "none";
        
        document.getElementById("questionCounter").textContent = 
            `Question ${currentQuestionIndex + 1} of ${interviewData.questions.length}`;
        updateProgressTracker(currentQuestionIndex + 1, interviewData.questions.length);
    }
    
    // IMPORTANT: Speak the question ONCE
    speakText(currentQuestionText, "main-question");
    
    // Start recording
    recordAudioWithSilenceDetection().then(audioBlob => {
        const formData = new FormData();
        formData.append("file", audioBlob, "answer.wav");
        formData.append("is_followup", isFollowUp);
        
        return fetch("/answer", {
            method: "POST",
            body: formData
        });
    })
    .then(response => response.json())
    .then(data => {
        // Store the answer
        if (isFollowUp) {
            interviewData.followupAnswers.push(data.transcript);
            addToTranscriptList("You (Follow-up response)", data.transcript);
            waitingForFollowupAnswer = false;
        } else {
            interviewData.answers.push(data.transcript);
            addToTranscriptList("You", data.transcript);
        }
        
        // Handle interview completion
        if (data.interview_complete) {
            if (data.followup) {
                addToTranscriptList("Interviewer (Closing)", data.followup);
                showClosingRemarks(data.followup);
                speakText(data.followup, "closing");
                
                setTimeout(() => {
                    isInterviewComplete = true;
                    endInterview();
                }, 5000);
            } else {
                isInterviewComplete = true;
                endInterview();
            }
            return;
        }
        
        // CRITICAL FIX: Handle the response based on is_follow_up flag
        if (data.is_follow_up) {
            // This is a follow-up question
            console.log("Received follow-up question:", data.followup);
            interviewData.followups.push(data.followup);
            addToTranscriptList("Interviewer (Follow-up)", data.followup);
            waitingForFollowupAnswer = true;
            
            // Speak follow-up and start next cycle
            speakText(data.followup, "follow-up");
            setTimeout(() => processNextQuestion(), 100);
            return;
        } else {
            // This is a transition to the next question
            if (data.followup) {
                console.log("Received transition to next question:", data.followup);
                
                // Update transcript with transition
                addToTranscriptList("Interviewer", data.followup);
                
                // IMPORTANT: Update question index BEFORE speaking the transition
                if (data.next_question !== null && data.next_question !== undefined) {
                    currentQuestionIndex = data.next_question;
                }
                
                // Speak ONLY the transition, not the next question
                speakText(data.followup, "transition");
                
                // Start next cycle after a short delay
                setTimeout(() => processNextQuestion(), 100);
                return;
            }
        }
        
        // Simple next question (no transition)
        if (data.next_question !== null && data.next_question !== undefined) {
            currentQuestionIndex = data.next_question;
            setTimeout(() => processNextQuestion(), 100);
        } else {
            isInterviewComplete = true;
            endInterview();
        }
    })
    .catch(error => {
        console.error("Error in processNextQuestion:", error);
    });
}

// 5. Customize the startInterviewWithWelcome function
async function startInterviewWithWelcome() {
    console.log("Starting interview with welcome...");

    try {
        // Speak welcome message only if not already played
        if (!welcomeMessagePlayed) {
            console.log("Speaking welcome message");
            await speakText("Hello, welcome to this interview!", "welcome");
            welcomeMessagePlayed = true;
        }

        // Don't speak the first question here - let processNextQuestion handle it
        processNextQuestion();
    } catch (error) {
        console.error("Error during interview start:", error);
    }
}

// Add hooks to recordAudioWithSilenceDetection for debugging
const originalRecordAudio = recordAudioWithSilenceDetection;
recordAudioWithSilenceDetection = function() {
    console.log("DEBUG RECORD: Starting audio recording");
    return originalRecordAudio.apply(this, arguments).then(result => {
        console.log("DEBUG RECORD: Audio recording complete");
        return result;
    });
};


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


// Update the displayFullTranscript function

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
                let currentQuestionNum = 0;
                let inFollowUp = false;
                
                data.transcript.forEach((entry) => {
                    const isAI = entry.speaker === "AI";
                    const isFollowUp = entry.is_followup === true;
                    const isFollowUpAnswer = entry.is_followup_answer === true;
                    const isTransition = entry.transition_to !== undefined;
                    
                    // Create the entry element
                    const entryElement = document.createElement("p");
                    
                    // Determine the CSS class and prefix based on the type of entry
                    if (isAI) {
                        if (isFollowUp) {
                            entryElement.className = "interviewer followup";
                            entryElement.textContent = `Interviewer (Follow-up): ${entry.text}`;
                            inFollowUp = true;
                        } else if (isTransition) {
                            entryElement.className = "interviewer transition";
                            entryElement.textContent = `Interviewer: ${entry.text}`;
                            inFollowUp = false;
                        } else {
                            // Regular question
                            currentQuestionNum = entry.question_number || currentQuestionNum + 1;
                            entryElement.className = "interviewer question";
                            entryElement.textContent = `Interviewer (Question ${currentQuestionNum}): ${entry.text}`;
                            inFollowUp = false;
                        }
                    } else {
                        // Human response
                        if (isFollowUpAnswer || inFollowUp) {
                            entryElement.className = "interviewee followup-answer";
                            entryElement.textContent = `You (Follow-up response): ${entry.text}`;
                        } else {
                            entryElement.className = "interviewee";
                            entryElement.textContent = `You: ${entry.text}`;
                        }
                    }
                    
                    transcriptContainer.appendChild(entryElement);
                });
            } else {
                // Fallback to local data if server doesn't have transcript
                console.log("No server transcript, using local data");
                
                // Process main questions and answers
                interviewData.questions.forEach((question, index) => {
                    const questionElement = document.createElement("p");
                    questionElement.className = "interviewer question";
                    questionElement.textContent = `Interviewer (Question ${index + 1}): ${question}`;
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
                            followupAnswerElement.textContent = `You (Follow-up response): ${interviewData.followupAnswers[index]}`;
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
