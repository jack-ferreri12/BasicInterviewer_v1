// Core state variables
let mode = null;
let currentQuestionIndex = 0;
let interviewData = {
    questions: [],
    answers: [],
    transcripts: []
};

// WebSocket and audio variables
let socket = null;
let audioContext = null;
let audioStream = null;
let audioSourceNode = null;
let vadNode = null;
let isRecording = false;
let isSpeaking = false;
let fullMediaRecorder = null;
let fullMediaStream = null;
let fullRecordingBlobs = [];

// Audio constants
const AUDIO_SAMPLE_RATE = 16000;
const VAD_FRAME_DURATION_MS = 20;

// Simple application state manager
const AppState = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    SPEAKING: 'speaking',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    COMPLETE: 'complete',
    ERROR: 'error',
    
    _current: 'idle',
    
    get current() {
        return this._current;
    },
    
    set current(newState) {
        const oldState = this._current;
        this._current = newState;
        console.log(`App State: ${oldState} -> ${newState}`);
        this._updateUI(newState);
    },
    
    _updateUI(state) {
        const statusElement = document.getElementById("recordingStatus");
        if (!statusElement) return;
        
        switch(state) {
            case this.IDLE:
                statusElement.textContent = "Ready";
                break;
            case this.CONNECTING:
                statusElement.textContent = "Connecting...";
                break;
            case this.SPEAKING:
                statusElement.textContent = "Speaking...";
                break;
            case this.LISTENING:
                statusElement.textContent = "Listening...";
                break; 
            case this.PROCESSING:
                statusElement.textContent = "Processing...";
                break;
            case this.COMPLETE:
                statusElement.textContent = "Interview complete";
                break;
            case this.ERROR:
                statusElement.textContent = "Error - please refresh";
                break;
        }
    }
};

// === UI Helper Functions ===
function hideAllModes() {
    const ids = [
        "customQuestionSection",
        "jobLinkSection",
        "jobDescriptionSection",
        "interviewStatusSection"
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
    });
}

function addQuestionInput() {
    const questionContainer = document.getElementById("questionContainer");
    const newQuestionBox = document.createElement("div");
    newQuestionBox.classList.add("questionBox");
    newQuestionBox.innerHTML = `
        <input type="text" class="questionInput" placeholder="Enter your question here" />
    `;
    questionContainer.appendChild(newQuestionBox);

    const startBtn = document.getElementById("startInterview");
    startBtn.style.display = "inline-block";
    startBtn.disabled = false;
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

// === WebSocket Management ===
async function connectWebSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        console.log("WebSocket already connected");
        return;
    }

    AppState.current = AppState.CONNECTING;
    
    try {
    // Determine WebSocket protocol (ws or wss)
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${wsProtocol}//${window.location.host}/ws/interview_control`;
    console.log(`Connecting to WebSocket: ${wsUrl}`);
    
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
            console.log("WebSocket connection established");
            AppState.current = AppState.IDLE;
        };
        
        socket.onmessage = handleSocketMessage;
        
        socket.onerror = (error) => {
            console.error("WebSocket error:", error);
            AppState.current = AppState.ERROR;
        };
        
        socket.onclose = (event) => {
            console.log(`WebSocket closed (code: ${event.code})`);
            if (AppState.current !== AppState.COMPLETE && AppState.current !== AppState.ERROR) {
                AppState.current = AppState.ERROR;
            }
            socket = null;
        };
    } catch (error) {
        console.error("Failed to connect WebSocket:", error);
        AppState.current = AppState.ERROR;
    }
}

async function handleSocketMessage(event) {
    try {
        const message = JSON.parse(event.data);
        console.log("WebSocket message received:", message);
        
        // If we're recording, stop it immediately - TTS takes priority
        if (isRecording) {
            await stopAudioRecording();
        }
        
        // Update UI with the received information
        if (message.current_question_text) {
            if (message.is_follow_up_ask) {
                document.getElementById("currentQuestion").textContent = "Follow-up Question:";
                document.getElementById("followup").style.display = "block";
                document.getElementById("followup").textContent = message.current_question_text;
            } else {
                document.getElementById("currentQuestion").textContent = message.current_question_text;
                document.getElementById("followup").style.display = "none";
            }
        }
        
        if (message.question_number && message.questions_total) {
            updateProgressTracker(message.question_number, message.questions_total);
        }
        
        // Add transcript entries
        if (message.user_transcript) {
            const userLabel = message.is_follow_up_ask ? "You (Follow-up)" : "You";
            addToTranscriptList(userLabel, message.user_transcript);
        }
        
        // Handle initial question case (interview_ready)
        if (message.type === "interview_ready" && message.current_question_text) {
            try {
                // Speak the initial question
                AppState.current = AppState.SPEAKING;
                await speakText(message.current_question_text);
                
                // Notify server that TTS is complete
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: "tts_complete" }));
                }
            } catch (err) {
                console.error("Error during initial question TTS:", err);
                // Still notify server even if TTS fails
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: "tts_complete" }));
                }
            }
        }
        
        // Handle AI response
        if (message.ai_response && message.type !== "interview_ready") {
            const aiLabel = message.is_follow_up_ask ? "Interviewer (Follow-up)" : 
                           (message.type === "no_speech_detected" ? "Interviewer (Retry)" : "Interviewer");
            
            addToTranscriptList(aiLabel, message.ai_response);
            
            try {
                // Speak the AI response
                AppState.current = AppState.SPEAKING;
                await speakText(message.ai_response);
                
                // If there's a next question that's different from the AI response, speak it too
                if (!message.is_follow_up_ask && 
                    message.next_question_text && 
                    message.next_question_text !== message.ai_response) {
                    await speakText(message.next_question_text);
                }
                
                // Notify server that TTS is complete
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: "tts_complete" }));
                }
            } catch (err) {
                console.error("Error during TTS:", err);
                // Still notify server even if TTS fails
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: "tts_complete" }));
                }
            }
        }
        
        // Handle ready to listen event
        if (message.type === "ready_to_listen") {
            console.log("Server ready to listen");
            // Only start recording if we're not already speaking
            if (!isSpeaking) {
                setTimeout(() => {
                    startAudioRecording();
                }, 500); // Small delay to ensure everything is ready
            }
        }
        
        // Handle interview completion
        if (message.interview_complete) {
            console.log("Interview complete");
            AppState.current = AppState.COMPLETE;
            const closingMessage = message.ai_response || message.message || "The interview is now complete. Thank you!";
            showClosingRemarks(closingMessage); 
            setTimeout(() => {
                endInterview(); 
            }, 3000); 
        }
    } catch (error) {
        console.error("Error processing WebSocket message:", error);
    }
}

// === TTS Implementation ===
async function speakText(text) {
    if (!text || text.trim() === "") {
        console.log("Empty text provided for TTS, skipping");
        return;
    }

    console.log(`Speaking text: "${text.substring(0, 50)}..." (${text.length} chars)`);
    isSpeaking = true;
    
    // Set a global timeout for the entire TTS operation
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error("TTS operation timed out after 30 seconds"));
        }, 30000);
    });

    try {
        // Race the fetch against the timeout
        const fetchPromise = fetch("/speak_question", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: text })
        });
        
        const response = await Promise.race([fetchPromise, timeoutPromise]);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
            
            if (errorData.fallback_text) {
                console.warn("TTS failed but received fallback text");
                return; // Continue without audio
            }
            throw new Error(`TTS request failed: ${errorData.error || response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.status === "success" && data.audio_url) {
            console.log(`Received TTS audio: ${data.audio_url}`);
            // Play the audio
            const audio = new Audio(data.audio_url);
            
            await new Promise((resolve, reject) => {
                // Set a loading timeout
                const loadTimeout = setTimeout(() => {
                    reject(new Error("Audio loading timed out after 10 seconds"));
                }, 10000);
                
                audio.oncanplaythrough = () => {
                    clearTimeout(loadTimeout);
                    console.log("Audio ready to play");
                    
                    audio.play().catch(error => {
                        reject(new Error(`Failed to play audio: ${error.message}`));
                    });
                };
                
                audio.onended = () => {
                    console.log("Audio playback complete");
                    resolve();
                };
                
                audio.onerror = (event) => {
                    clearTimeout(loadTimeout);
                    reject(new Error(`Audio error: ${event.type}`));
                };
                
                // Start loading
                try {
                    audio.load();
                } catch (error) {
                    clearTimeout(loadTimeout);
                    reject(new Error(`Failed to load audio: ${error.message}`));
                }
            });
        } else {
            throw new Error(data.message || "TTS response did not contain audio URL");
        }
    } catch (error) {
        console.error("TTS error:", error);
        // We continue the interview flow even if TTS fails
    } finally {
        // Always clear the timeout and mark TTS as complete
        if (timeoutId) clearTimeout(timeoutId);
        isSpeaking = false;
    }
}

// === Audio Recording ===
async function startAudioRecording() {
    if (isRecording) {
        console.log("Already recording");
                return;
            }

    if (isSpeaking) {
        console.log("Cannot start recording while speaking");
        return;
    }
    
    AppState.current = AppState.LISTENING;
    
    try {
        // Create AudioContext
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ 
            sampleRate: AUDIO_SAMPLE_RATE 
        });
        
        // Get user media
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: AUDIO_SAMPLE_RATE,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true
            }
        });
        
        // Create source node
        audioSourceNode = audioContext.createMediaStreamSource(audioStream);
        
        // Load the VAD audio processor
        await audioContext.audioWorklet.addModule('/static/vad-audio-processor.js');
        
        // Create VAD node
        vadNode = new AudioWorkletNode(audioContext, 'vad-audio-processor', {
            processorOptions: {
                sampleRate: AUDIO_SAMPLE_RATE,
                frameDurationMs: VAD_FRAME_DURATION_MS
            }
        });
        
        // Set up VAD node message handler
        vadNode.port.onmessage = (event) => {
            if (!isRecording) return;
            
            const audioData = event.data;
            
            // Send audio data through WebSocket
            if (socket && socket.readyState === WebSocket.OPEN) {
                try {
                    socket.send(audioData);
                } catch (error) {
                    console.error("Error sending audio data:", error);
                    // If there's an error sending, stop recording
                    stopAudioRecording();
                }
                } else {
                console.warn("Cannot send audio - WebSocket not connected");
                stopAudioRecording();
            }
        };
        
        // Connect nodes
        audioSourceNode.connect(vadNode);
        vadNode.connect(audioContext.destination);
        
        isRecording = true;
        console.log("Audio recording started");
    } catch (error) {
        console.error("Error starting audio recording:", error);
        AppState.current = AppState.ERROR;
    }
}

async function stopAudioRecording() {
    if (!isRecording) {
        return;
    }
    
    console.log("Stopping audio recording");
    isRecording = false;
    
    try {
        // First stop the VAD processor from sending more data
        if (vadNode && vadNode.port) {
            try {
                vadNode.port.onmessage = null; // Detach handler first
                vadNode.port.postMessage('stop');
                console.log("Sent stop message to VAD processor");
            } catch (e) {
                console.warn("Error sending stop message to VAD processor:", e);
            }
        }
        
        // Notify the server that audio has ended
        if (socket && socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify({ type: "client_audio_ended" }));
                console.log("Sent client_audio_ended message");
            } catch (e) {
                console.error("Error sending client_audio_ended:", e);
            }
        }
        
        AppState.current = AppState.PROCESSING;
        
        // Clean up audio resources
        if (vadNode) {
            try {
                vadNode.disconnect();
                console.log("Disconnected VAD node");
            } catch (e) {
                console.warn("Error disconnecting VAD node:", e);
            }
            vadNode = null;
        }
        
    if (audioSourceNode) {
            try {
        audioSourceNode.disconnect();
                console.log("Disconnected audio source node");
            } catch (e) {
                console.warn("Error disconnecting audio source node:", e);
            }
        audioSourceNode = null;
    }
        
        if (audioStream) {
            try {
                audioStream.getTracks().forEach(track => {
                    try {
                        track.stop();
                        console.log("Stopped audio track");
                    } catch (trackErr) {
                        console.warn("Error stopping audio track:", trackErr);
                    }
                });
            } catch (e) {
                console.warn("Error stopping audio stream tracks:", e);
            }
            audioStream = null;
        }
        
        if (audioContext && audioContext.state !== "closed") {
            try {
                await audioContext.close();
                console.log("Closed AudioContext");
            } catch (e) {
                console.warn("Error closing AudioContext:", e);
            }
            audioContext = null;
        }
        
        console.log("Audio recording stopped and resources cleaned up");
    } catch (error) {
        console.error("Error stopping audio recording:", error);
    }
}

// === Full session video recording ===
async function startVideoRecording() {
    try {
        fullMediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

        // Show the webcam on screen
        const videoElement = document.getElementById("liveVideo");
        videoElement.srcObject = fullMediaStream;
        videoElement.style.display = "block"; 
        videoElement.play();

        // Record audio+video
        fullRecordingBlobs = [];
        fullMediaRecorder = new MediaRecorder(fullMediaStream);

        fullMediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) fullRecordingBlobs.push(e.data);
        };

        fullMediaRecorder.start(1000);
        console.log("Video recording started");
    } catch (err) {
        console.error("Failed to start video recording:", err);
    }
}

function stopAndShowRecording() {
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

    document.getElementById("videoPlaybackContainer").appendChild(videoPlayer);
    console.log("Video recording stopped and displayed");
}

// === Interview Flow Management ===
async function startInterview() {
    console.log("Starting interview");
    
    const inputs = document.querySelectorAll(".questionInput");
    const questions = Array.from(inputs).map(input => input.value.trim()).filter(Boolean);

    if (questions.length === 0) {
        alert("Please add at least one question.");
        return;
    }

    interviewData.questions = questions;
    currentQuestionIndex = 0;

    for (const q of questions) {
        console.log("Submitting question to backend:", q);
        await fetch("/submit_custom_question", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: q }),
        });
    }

    document.getElementById("startInterview").style.display = "none";
    hideAllModes();
    document.getElementById("interviewStatusSection").style.display = "block";
    updateProgressTracker(1, questions.length);

    // Start the interview session
    await connectWebSocket();
    await startVideoRecording();
}

async function endInterview() {
    console.log("Ending interview");
    
    // Clean up recording if active
    if (isRecording) {
        await stopAudioRecording();
    }
    
    // Close WebSocket
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
        socket = null;
    }

    // Stop video recording
    stopAndShowRecording();
    
    // Notify server
    fetch("/end_interview", { method: "POST" })
        .catch(err => console.error("Error ending interview on server:", err));
    
    // Show transcript
    document.getElementById("interviewStatusSection").style.display = "none";
    document.getElementById("complete-container").style.display = "block";
    displayFullTranscript();
}

function displayFullTranscript() {
    const transcriptContainer = document.getElementById("fullTranscript");
    transcriptContainer.innerHTML = ""; // Clear existing content
    
    // Add header
    const headerElement = document.createElement("h3");
    headerElement.textContent = "Complete Interview Transcript";
    transcriptContainer.appendChild(headerElement);
    
    // Get full transcript from API
    fetch("/get_transcript")
        .then(response => response.json())
        .then(data => {
            if (data.transcript && data.transcript.length > 0) {
                let currentQuestionNum = 0;
                let inFollowUp = false;
                
                data.transcript.forEach((entry) => {
                    const isAI = entry.speaker === "AI";
                    const isFollowUp = entry.is_followup === true;
                    const isFollowUpAnswer = entry.is_followup_answer === true;
                    const isTransition = entry.transition_to !== undefined;
                    
                    // Create entry element
                    const entryElement = document.createElement("p");
                    
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
                            currentQuestionNum = entry.question_number || currentQuestionNum + 1;
                            entryElement.className = "interviewer question";
                            entryElement.textContent = `Interviewer (Question ${currentQuestionNum}): ${entry.text}`;
                            inFollowUp = false;
                        }
                    } else {
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
                // Fallback to local data
                console.log("No server transcript, using local data");
                
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
                });
            }
            
            // Add download button
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
            const errorElement = document.createElement("p");
            errorElement.textContent = "Error loading transcript. Please try again.";
            errorElement.style.color = "red";
            transcriptContainer.appendChild(errorElement);
        });
}

function downloadTranscriptAsText() {
    let transcriptText = "INTERVIEW TRANSCRIPT\n\n";
    
    const transcriptEntries = document.querySelectorAll("#fullTranscript p");
    transcriptEntries.forEach(entry => {
        transcriptText += entry.textContent + "\n\n";
    });
    
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

// === Event Listeners ===
document.addEventListener("DOMContentLoaded", () => {
    // Check for preset questions from localStorage
    const presetData = localStorage.getItem("presetQuestions");
    if (presetData) {
        const questions = JSON.parse(presetData);
        localStorage.removeItem("presetQuestions");

        interviewData.questions = questions;
        currentQuestionIndex = 0;

        // Just show the interview UI and start
        document.getElementById("interviewStatusSection").style.display = "block";
        updateProgressTracker(1, questions.length);
        
        // Submit the questions
        (async () => {
            for (const q of questions) {
                await fetch("/submit_custom_question", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ question: q }),
                });
            }
            // Start interview
            await connectWebSocket();
            await startVideoRecording();
        })();
    }
    
    // Mode selection buttons
    document.getElementById("startCustom")?.addEventListener("click", () => {
        hideAllModes();
        document.getElementById("customQuestionSection").style.display = "block";
        addQuestionInput();
    });

    document.getElementById("startJobLink")?.addEventListener("click", () => {
        hideAllModes();
        document.getElementById("jobLinkSection").style.display = "block";
    });

    document.getElementById("startJobDescription")?.addEventListener("click", () => {
        hideAllModes();
        document.getElementById("jobDescriptionSection").style.display = "block";
    });

    document.getElementById("startPopular")?.addEventListener("click", () => {
        window.location.href = "/popular";
    });

    // Custom questions
    document.getElementById("addQuestionBtn")?.addEventListener("click", addQuestionInput);
    document.getElementById("startInterview")?.addEventListener("click", startInterview);
});
