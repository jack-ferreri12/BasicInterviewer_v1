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
let waitingForFollowupAnswer = false;
let fullMediaRecorder = null;
let fullRecordingBlobs = [];
let fullMediaStream = null;
let justTransitioned = false;

// WebSocket and Audio Streaming Globals
let socket = null;
const AUDIO_SAMPLE_RATE = 16000;
const VAD_FRAME_DURATION_MS = 20; // Must match server's RealtimeVADProcessor config
// Calculate bytes: Rate * Duration_sec * Channels (1 for mono) * BytesPerSample (2 for 16-bit)
const VAD_BYTES_PER_FRAME = AUDIO_SAMPLE_RATE * (VAD_FRAME_DURATION_MS / 1000) * 1 * 2;
let audioContext = null;
let scriptProcessorNode = null;
let audioSourceNode = null;
let localAudioStream = null; // For VAD streaming, separate from fullMediaStream for video
let isStreamingAudio = false;

// === Helper ===
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

// === Interview Mode Buttons ===
document.getElementById("startCustom")?.addEventListener("click", () => {
    console.log("Start Custom clicked");
    hideAllModes();
    document.getElementById("customQuestionSection").style.display = "block";
    addQuestionInput();
});

document.getElementById("startJobLink")?.addEventListener("click", () => {
    console.log("Job Link clicked");
    hideAllModes();
    document.getElementById("jobLinkSection").style.display = "block";
});

document.getElementById("startJobDescription")?.addEventListener("click", () => {
    console.log("Job Description clicked");
    hideAllModes();
    document.getElementById("jobDescriptionSection").style.display = "block";
});

document.getElementById("startPopular")?.addEventListener("click", () => {
    window.location.href = "/popular";
});

// === Custom Question Handlers ===
document.getElementById("addQuestionBtn")?.addEventListener("click", () => {
    console.log("Add Question clicked");
    addQuestionInput();
});

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

document.getElementById("startInterview")?.addEventListener("click", async () => {
    console.log("Start Interview clicked");

    const inputs = document.querySelectorAll(".questionInput");
    const questions = Array.from(inputs).map(input => input.value.trim()).filter(Boolean);

    if (questions.length === 0) {
        alert("Please add at least one question.");
        return;
    }

    interviewData.questions = questions;
    currentQuestionIndex = 0;
    isInterviewComplete = false;
    waitingForFollowupAnswer = false;

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

    await startInterviewWithWelcome();
});

// === Preset Question Flow ===
document.addEventListener("DOMContentLoaded", async () => {
    const presetData = localStorage.getItem("presetQuestions");
    if (presetData) {
        const questions = JSON.parse(presetData);
        localStorage.removeItem("presetQuestions");

        interviewData.questions = questions;
        currentQuestionIndex = 0;
        isInterviewComplete = false;
        waitingForFollowupAnswer = false;

        for (const q of questions) {
            await fetch("/submit_custom_question", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question: q }),
            });
        }

        document.getElementById("interviewStatusSection").style.display = "block";
        updateProgressTracker(1, questions.length);
        await startInterviewWithWelcome();
    }
});


async function startInterviewWithWelcome() {
    console.log("Starting interview with welcome...");

    try {
        // Establish WebSocket connection first
        await connectWebSocket(); // New function call

        // Video recording for the whole session starts here
        await startVideoRecording(); 

        // The server will now manage the flow, including when to speak the welcome/first question
        // So, direct TTS calls from here might be redundant or need coordination with WebSocket messages

        // For custom questions, questions are already submitted in startInterview click handler.
        // For preset questions, they are submitted in DOMContentLoaded.
        // The /start endpoint on the server now returns the first question if available.
        // The client should wait for server instruction via WebSocket to display/speak it.

        // Example: Server might send an initial message after WebSocket connection:
        // { type: "interview_started", initial_question: "...", question_number: 1 }
        // This logic will be handled in socket.onmessage

        // We no longer call processNextQuestion() directly here.
        // The flow is now driven by messages from the WebSocket.

    } catch (error) {
        console.error("Error during interview start:", error);
        // Display error to user
        document.getElementById("currentQuestion").textContent = "Error starting interview. Please refresh and try again.";
    }
}

// New WebSocket Functions
async function connectWebSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        console.log("WebSocket already connected.");
        return;
    }

    // Determine WebSocket protocol (ws or wss)
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/interview_audio`;
    console.log(`Connecting to WebSocket: ${wsUrl}`);
    
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log("WebSocket connection established.");
        document.getElementById("recordingStatus").textContent = "Connected. Waiting for interview to start...";
        // The server will send an initial message after the /start HTTP call has set up the session.
    };

    socket.onmessage = (event) => {
        const serverMessage = JSON.parse(event.data);
        console.log("WebSocket message received:", serverMessage);

        if (serverMessage.error) {
            console.error("Error from server via WebSocket:", serverMessage.error);
            document.getElementById("recordingStatus").textContent = `Error: ${serverMessage.error}`;
            if(isStreamingAudio) stopAudioStreaming();
            return;
        }

        if (isStreamingAudio && serverMessage.type !== 'vad_interim_result') { 
            stopAudioStreaming();
        }
 
        if (serverMessage.user_transcript) {
            const lastAIWasFollowup = waitingForFollowupAnswer; 
            addToTranscriptList(lastAIWasFollowup ? "You (Follow-up)" : "You", serverMessage.user_transcript);
        }
 
        if (serverMessage.ai_response) {
            const aiSpeaker = serverMessage.is_follow_up_ask ? "Interviewer (Follow-up)" : "Interviewer";
            addToTranscriptList(aiSpeaker, serverMessage.ai_response);
            speakText(serverMessage.ai_response, serverMessage.is_follow_up_ask ? "follow-up_response" : "transition_response")
                .then(() => {
                    handlePostAIResponse(serverMessage, true /* aiResponseWasSpoken */);
                })
                .catch(err => {
                    console.error("TTS for AI response failed. Proceeding with interview flow.", err);
                    handlePostAIResponse(serverMessage, true /* aiResponseWasSpoken, but failed */);
                });
        } else if (serverMessage.type === "interview_ready" || serverMessage.type === "next_question_prompt" || serverMessage.status === "no_speech_detected") {
            // If no ai_response to speak, but other actions are needed (like handling no_speech_detected status or initial question)
            handlePostAIResponse(serverMessage, false /* aiResponseWasSpoken */);
        } 

        // --- Update UI for current/next question text (independent of TTS completion) ---
        if (serverMessage.current_question_text) { // Server should ideally send this for clarity
            if(serverMessage.is_follow_up_ask) {
                document.getElementById("currentQuestion").textContent = "Follow-up Question:";
                document.getElementById("followup").style.display = "block";
                document.getElementById("followup").textContent = serverMessage.current_question_text;
            } else {
                document.getElementById("currentQuestion").textContent = serverMessage.current_question_text;
                document.getElementById("followup").style.display = "none";
            }
        } else if (serverMessage.type === "interview_ready" && !serverMessage.current_question_text && !serverMessage.interview_complete) {
             document.getElementById("currentQuestion").textContent = serverMessage.message || "Waiting for custom questions or server...";
             document.getElementById("followup").style.display = "none";
        }

        // --- Update Progress Tracker ---
        if (serverMessage.question_number && serverMessage.questions_total) {
            updateProgressTracker(serverMessage.question_number, serverMessage.questions_total);
        }
        
        // --- Update Client-Side State ---
        waitingForFollowupAnswer = serverMessage.is_follow_up_ask || false;
        if (serverMessage.question_number != null) { // 0 is valid for custom mode start
             currentQuestionIndex = serverMessage.question_number -1; // Keep 0-indexed internally if server sends 1-based
        }
       
        // --- Handle Interview Completion --- 
        if (serverMessage.interview_complete) {
            isInterviewComplete = true;
            if (isStreamingAudio) stopAudioStreaming();
            
            const closingMessage = serverMessage.ai_response || serverMessage.message || "The interview is now complete. Thank you!";
            // ai_response TTS would have been handled above. If showClosingRemarks has its own, coordinate.
            showClosingRemarks(closingMessage); 
            setTimeout(() => {
                endInterview(); 
            }, 3000); 
        }
    };

    socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        document.getElementById("recordingStatus").textContent = "Connection error. Please refresh.";
        if(isStreamingAudio) stopAudioStreaming();
    };

    socket.onclose = (event) => {
        console.log("WebSocket connection closed:", event.reason, `Code: ${event.code}`);
        document.getElementById("recordingStatus").textContent = "Disconnected. Please refresh to restart.";
        if(isStreamingAudio) stopAudioStreaming();
        // Optionally, attempt to reconnect or inform the user.
        // For simplicity, user needs to refresh for now.
        socket = null; // Clear the socket object
    };
    return Promise.resolve(); // connectWebSocket itself is async due to logging mainly
}

async function startAudioStreaming() {
    if (isStreamingAudio) {
        console.log("Audio streaming is already active.");
        return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error("WebSocket is not connected. Cannot start audio streaming.");
        document.getElementById("recordingStatus").textContent = "Not connected. Try refreshing.";
        return;
    }

    console.log("Attempting to start audio streaming...");
    document.getElementById("recordingStatus").textContent = "Listening...";
    isStreamingAudio = true;

    try {
        localAudioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: AUDIO_SAMPLE_RATE,
                channelCount: 1,
                // Other constraints like echoCancellation: true can be added
            }
        });

        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE });
        audioSourceNode = audioContext.createMediaStreamSource(localAudioStream);
        
        // Buffer size for ScriptProcessorNode. Min 256, max 16384. Powers of 2.
        // We need to send VAD_BYTES_PER_FRAME bytes every VAD_FRAME_DURATION_MS.
        // ScriptProcessorNode buffer size should allow us to collect enough samples.
        // If VAD_BYTES_PER_FRAME is, for example, 640 bytes (16kHz, 20ms, 16bit mono),
        // and typical script processor buffer sizes are 1024, 2048, 4096 samples.
        // 4096 samples at 16kHz is 256ms. We need to send data every 20ms.
        // This means onaudioprocess will be called with a buffer, and we need to extract
        // 20ms chunks from it and send them. This requires careful handling.

        // Let's try a buffer size that gives us a reasonable callback frequency.
        // e.g. 1024 samples. At 16kHz, this is 1024/16000 = 64ms.
        // Inside this 64ms, we'd have three 20ms VAD frames (plus a bit).
        
        // A more direct approach for ScriptProcessorNode to align with VAD frames:
        // Choose a buffer size for ScriptProcessorNode that is a multiple of our VAD frame size in samples.
        // VAD frame size in samples = AUDIO_SAMPLE_RATE * (VAD_FRAME_DURATION_MS / 1000) = 16000 * 0.020 = 320 samples.
        // Let ScriptProcessorNode buffer be, say, 1024 or 2048.
        // If bufferSize = 1024, onaudioprocess gives 1024 samples. We need to send 320-sample chunks.
        
        // For simplicity in this example, let's assume a buffer size for ScriptProcessorNode that
        // is reasonably small, and we process it. AudioWorklet is better for precise frame-by-frame.
        const bufferSize = 4096; // Can be 0 to let browser pick, or 256, 512, 1024, 2048, 4096, 8192, 16384.

        scriptProcessorNode = audioContext.createScriptProcessor(bufferSize, 1, 1); // 1 input channel, 1 output channel

        let internalBuffer = new Int16Array(0);

        scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
            if (!isStreamingAudio || !socket || socket.readyState !== WebSocket.OPEN) {
                return;
            }

            const inputBuffer = audioProcessingEvent.inputBuffer;
            const pcmDataFloat = inputBuffer.getChannelData(0); // Float32 array (-1.0 to 1.0)
            
            // Convert Float32 to Int16 PCM
            let newPcmInt16 = new Int16Array(pcmDataFloat.length);
            for (let i = 0; i < pcmDataFloat.length; i++) {
                let val = Math.max(-1, Math.min(1, pcmDataFloat[i]));
                newPcmInt16[i] = val * 0x7FFF; // 0x7FFF is 32767
            }

            // Append to our internal buffer
            const oldInternalBufferLength = internalBuffer.length;
            let temp = new Int16Array(oldInternalBufferLength + newPcmInt16.length);
            temp.set(internalBuffer, 0);
            temp.set(newPcmInt16, oldInternalBufferLength);
            internalBuffer = temp;

            // Process in VAD_BYTES_PER_FRAME chunks
            while (internalBuffer.length * 2 >= VAD_BYTES_PER_FRAME) { // *2 because VAD_BYTES_PER_FRAME is in bytes, internalBuffer is Int16
                const samplesForFrame = VAD_BYTES_PER_FRAME / 2; // Number of Int16 samples for one VAD frame
                console.log(`[AudioStreamer] Loop Iteration: internalBuffer.length=${internalBuffer.length}, samplesForFrame=${samplesForFrame}, VAD_BYTES_PER_FRAME=${VAD_BYTES_PER_FRAME}`);
                const chunkInt16 = internalBuffer.subarray(0, samplesForFrame);
                const remainingInt16 = internalBuffer.subarray(samplesForFrame);
                
                internalBuffer = remainingInt16;

                // Send chunkInt16.buffer (which is an ArrayBuffer of the Int16 data)
                if (socket && socket.readyState === WebSocket.OPEN && isStreamingAudio) {
                    // Log the byte length of the buffer being sent
                    // console.log(`[AudioStreamer] Sending chunk of size: ${chunkInt16.buffer.byteLength} bytes. Expected VAD_BYTES_PER_FRAME: ${VAD_BYTES_PER_FRAME}`);
                    // socket.send(chunkInt16.buffer.slice(0)); // Send a copy of the ArrayBuffer
                    
                    const chunkToSend = new Int16Array(chunkInt16); // Creates a new Int16Array, with its own new ArrayBuffer, copying values
                    console.log(`[AudioStreamer] Sending chunk of actual size: ${chunkToSend.buffer.byteLength} bytes. Expected VAD_BYTES_PER_FRAME: ${VAD_BYTES_PER_FRAME}`);
                    socket.send(chunkToSend.buffer);

                } else {
                    // Stop processing if socket closed or streaming stopped
                    console.log("Socket not open or streaming stopped, breaking audio send loop.");
                    if(isStreamingAudio) stopAudioStreaming(); // Clean up
                    return; 
                }
            }
        };

        audioSourceNode.connect(scriptProcessorNode);
        scriptProcessorNode.connect(audioContext.destination); // Necessary for onaudioprocess to fire in some browsers

        console.log("Audio streaming started with VAD frame size:", VAD_BYTES_PER_FRAME, "bytes");

    } catch (error) {
        console.error("Error starting audio streaming:", error.name, error.message);
        isStreamingAudio = false; // Reset flag
        let userMessage = "Error accessing microphone.";
        if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
            userMessage = "Microphone permission denied. Please enable it in your browser settings.";
        } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
            userMessage = "No microphone found. Please ensure one is connected and enabled.";
        } else if (error.name === "AbortError") {
            userMessage = "Microphone access aborted. Please try again.";
        } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
            userMessage = "Microphone is already in use or cannot be read. Check other apps or browser tabs.";
        }
        // else if (error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError") {
        //     userMessage = "Audio settings (e.g. sample rate) not supported by your microphone.";
        // } // This case is less likely with our simple constraints but good to know
        
        document.getElementById("recordingStatus").textContent = userMessage;
        // Optionally, disable record button or provide a settings link here
    }
}

function stopAudioStreaming() {
    if (!isStreamingAudio && !localAudioStream) {
        console.log("Audio streaming is not active or already stopped.");
        return;
    }
    console.log("Stopping audio streaming...");
    isStreamingAudio = false; 

    if (scriptProcessorNode) {
        scriptProcessorNode.disconnect();
        scriptProcessorNode = null;
    }
    if (audioSourceNode) {
        audioSourceNode.disconnect();
        audioSourceNode = null;
    }
    if (audioContext && audioContext.state !== "closed") {
        audioContext.close().then(() => console.log("AudioContext closed."));
        audioContext = null;
    }
    if (localAudioStream) {
        localAudioStream.getTracks().forEach(track => track.stop());
        localAudioStream = null;
        console.log("Microphone stream stopped.");
    }
    document.getElementById("recordingStatus").textContent = "Not recording";
}

// New speakText function to handle client-side TTS playback
function speakText(textToSpeak, sourceDescription = "tts") {
    console.log(`[speakText - ${sourceDescription}] Requesting TTS for: "${textToSpeak}"`);
    return new Promise((resolve, reject) => {
        if (!textToSpeak || textToSpeak.trim() === "") {
            console.warn("[speakText] Empty text provided. Skipping TTS.");
            resolve(); // Resolve immediately if nothing to speak
            return;
        }

        fetch("/speak_question", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: textToSpeak }) // Server expects 'question'
        })
        .then(response => {
            if (!response.ok) {
                return response.json().then(errData => {
                    throw new Error(errData.error || `HTTP error ${response.status}`);
                });
            }
            return response.json();
        })
        .then(data => {
            if (data.status === "success" && data.audio_url) {
                console.log(`[speakText - ${sourceDescription}] Received audio URL: ${data.audio_url}`);
                const audioElement = new Audio(data.audio_url);
                
                audioElement.oncanplaythrough = () => {
                    console.log(`[speakText - ${sourceDescription}] Audio ready. Playing...`);
                    audioElement.play().catch(playError => {
                        console.error(`[speakText - ${sourceDescription}] Error playing audio:`, playError);
                        document.getElementById("recordingStatus").textContent = "Error playing audio response.";
                        reject(playError); // Reject promise if play fails
                    });
                };
                audioElement.onended = () => {
                    console.log(`[speakText - ${sourceDescription}] Audio playback finished.`);
                    resolve(); // Resolve promise when audio finishes
                };
                audioElement.onerror = (err) => {
                    console.error(`[speakText - ${sourceDescription}] Error with audio element:`, err);
                    document.getElementById("recordingStatus").textContent = "Error loading audio response.";
                    reject(err); // Reject promise on audio element error
                };
                // Start loading the audio. Important for some browsers/scenarios.
                audioElement.load();
            } else {
                console.error(`[speakText - ${sourceDescription}] TTS request failed or no audio URL:`, data.message || "Unknown error");
                document.getElementById("recordingStatus").textContent = "Failed to get audio response.";
                reject(new Error(data.message || "TTS request failed or no audio URL."));
            }
        })
        .catch(error => {
            console.error(`[speakText - ${sourceDescription}] Fetch error for TTS:`, error);
            document.getElementById("recordingStatus").textContent = "Error fetching audio response.";
            reject(error);
        });
    });
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

// Main function for handling the interview flow -
// THIS `processNextQuestion` FUNCTION WILL BE LARGELY REPLACED/DRIVEN BY WEBSOCKET MESSAGES
async function processNextQuestion() {
    console.log("processNextQuestion CALLED - THIS IS BEING REFACTORED FOR WEBSOCKETS");

    if (isInterviewComplete) {
        console.log("Interview is complete. No more questions.");
        // endInterview() should be called by the WebSocket message handler now
        return;
    }
    
    // Logic to display question and speak it is now primarily handled by WebSocket onmessage
    // when server sends new question or follow-up.

    // The old logic:
    // 1. Display question/follow-up (UI update)
    // 2. Speak question/follow-up (TTS)
    // 3. Record audio (recordAudioWithSilenceDetection) -> This becomes startAudioStreaming()
    // 4. Send audio to /answer (fetch POST) -> This is replaced by WebSocket sending chunks
    // 5. Process /answer response (JSON) -> This is replaced by WebSocket onmessage handler

    // NEW FLOW initiated from WebSocket `onmessage` handler:
    // A. Server sends new question/follow-up.
    // B. `onmessage` updates UI, calls speakText().
    // C. After speakText() for the question completes, `onmessage` or speakText callback calls `startAudioStreaming()`.
    // D. `startAudioStreaming()` sends audio chunks. Server VAD detects end of speech.
    // E. Server processes, sends result back. `onmessage` receives it, and loop continues from A or ends.

    // For now, this function might only be called initially if not handled by socket onopen/onmessage.
    // Or, it might be deprecated entirely if the server fully drives the question sequence via WebSocket.
    // Let's assume the initial question display and audio prompt is triggered from socket.onmessage
    // based on what the server sends after connection or after /start.

    // Example: if currentQuestionText is set by an initial message...
    // if (document.getElementById("currentQuestion").textContent !== "Waiting...") {
    //    console.log("processNextQuestion: Looks like a question is ready. Ensuring audio streaming starts if appropriate.");
    //    // This should be more intelligently placed, e.g., after TTS of question.
    //    // await speakText(document.getElementById("currentQuestion").textContent); // TTS is likely handled by onmessage
    //    // startAudioStreaming(); // This call is now primarily from socket.onmessage after TTS of question
    // }

    // The original call to recordAudioWithSilenceDetection and fetch /answer is removed.
    /*
    recordAudioWithSilenceDetection().then(audioBlob => {
        // ... old fetch /answer logic ...
    })
    .then(response => response.json())
    .then(data => {
        // ... old response processing logic ...
    })
    .catch(error => {
        console.error("Error in OLD processNextQuestion:", error);
    });
    */
    console.log("processNextQuestion: End of refactored placeholder. Waiting for WebSocket messages to drive flow.");
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

    if (isStreamingAudio) { // New check
        stopAudioStreaming();
    }
    if (socket && socket.readyState === WebSocket.OPEN) { // New check
        console.log("Closing WebSocket connection.");
        socket.close();
        socket = null;
    }

    // Stop full video recording (if it exists)
    // The original code stopped `audioStream` here, but that was for the old recorder.
    // `fullMediaStream` is for video + its own audio.
    stopAndShowRecording(); // This handles fullMediaStream tracks

    // Tell the server to officially end the interview (if not already done via WebSocket)
    // The server-side websocket disconnect might also trigger end state.
    // This fetch might be redundant if server handles disconnect well, but can be a fallback.
    fetch("/end_interview", {
        method: "POST"
    }).catch(err => console.error("Error explicitly ending interview on server:", err));

    document.getElementById("interviewStatusSection").style.display = "none";
    document.getElementById("complete-container").style.display = "block";
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

async function startVideoRecording() {
    try {
        fullMediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

        // Show the webcam on screen
        const videoElement = document.getElementById("liveVideo");
        videoElement.srcObject = fullMediaStream;
        videoElement.style.display = "block";  // ✅ Make sure it's visible
        videoElement.play();

        // Record audio+video
        fullRecordingBlobs = [];
        fullMediaRecorder = new MediaRecorder(fullMediaStream);

        fullMediaRecorder.ondataavailable = (e) => {
            console.log("Got video data:", e.data);
            if (e.data.size > 0) fullRecordingBlobs.push(e.data);
        };

        fullMediaRecorder.start(1000);
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

    document.getElementById("videoPlaybackContainer").appendChild(videoPlayer);
}

// Extracted logic to handle what happens AFTER AI response TTS is done, or if there's no AI TTS.
function handlePostAIResponse(serverMessage, aiResponseWasSpoken) {
    console.log("Handling post-AI response for message:", serverMessage, "AI response spoken:", aiResponseWasSpoken);
    if (serverMessage.interview_complete) {
        // Already handled by the main onmessage block, just ensure no further action.
        return;
    }

    if (serverMessage.status === "no_speech_detected") {
        // This block is for when the server detected no speech.
        // The server's "ai_response" (e.g., "I didn't catch that") should have already been spoken if it was present and aiResponseWasSpoken was true.
        // If aiResponseWasSpoken is false, it means the server directly sent "no_speech_detected" status without an ai_response for the socket.onmessage to speak.
        // In either case, our job now is to speak the *actual question again* (next_question_text).
        
        const statusMessage = "Didn't catch that. Let's try the question again.";
        document.getElementById("recordingStatus").textContent = statusMessage;

        if (!aiResponseWasSpoken) { // If the "no speech detected" message itself wasn't the ai_response
            // Speak a generic "didn't catch that" if the server didn't provide one as ai_response
            // This covers cases where the server might just send {status: "no_speech_detected", next_question_text: ...}
            speakText("I didn't quite catch that.", "generic_retry_prompt")
                .then(() => {
                    if (serverMessage.next_question_text) {
                        return speakText(serverMessage.next_question_text, "retry_question_after_no_speech");
                    }
                })
                .then(() => {
                    if (!isInterviewComplete) setTimeout(() => startAudioStreaming(), 100);
                })
                .catch(err => {
                    console.error("TTS for no_speech_detected flow failed. Listening anyway.", err);
                    if (!isInterviewComplete) setTimeout(() => startAudioStreaming(), 100);
                });
        } else if (serverMessage.next_question_text) {
            // aiResponseWasSpoken was true (e.g. "I didn't catch that" from server was spoken). Now speak the actual question.
            speakText(serverMessage.next_question_text, "retry_question_after_no_speech")
                .then(() => {
                    if (!isInterviewComplete) setTimeout(() => startAudioStreaming(), 100);
                })
                .catch(err => {
                    console.error("TTS for retry_question_after_no_speech failed. Listening anyway.", err);
                    if (!isInterviewComplete) setTimeout(() => startAudioStreaming(), 100);
                });
        } else { 
            // Fallback: just listen if no next_question_text after "no speech"
            if (!isInterviewComplete) setTimeout(() => startAudioStreaming(), 100);
        }
    } else if (aiResponseWasSpoken) {
        // An AI response was just spoken (e.g. normal answer, or follow-up AI question).
        // Now determine the next step.

        if (serverMessage.is_follow_up_ask) {
            // The AI's response *was* the follow-up question. It has been spoken. Now listen.
            console.log("AI asked a follow-up, now listening.");
            if (!isInterviewComplete) startAudioStreaming();
        } else if (serverMessage.next_question_text && serverMessage.next_question_text !== serverMessage.ai_response) {
            // There's a next question distinct from what was just spoken by ai_response. Speak it.
            console.log("Speaking next question:", serverMessage.next_question_text);
            speakText(serverMessage.next_question_text, "next_main_question")
                .then(() => {
                    if (!isInterviewComplete) startAudioStreaming();
                })
                .catch(err => {
                    console.error("TTS for next_main_question failed. Listening anyway.", err);
                    if (!isInterviewComplete) startAudioStreaming();
                });
        } else {
            // AI response was spoken, it wasn't a follow-up ask, and there's no *different* next_question_text.
            // This implies we should just listen for the user's response to what the AI just said.
            console.log("AI response spoken. No distinct next question. Listening.");
            if (!isInterviewComplete) startAudioStreaming();
        }
    } else if (!aiResponseWasSpoken && serverMessage.current_question_text) {
        // No initial AI response was spoken by the `socket.onmessage`'s `if (serverMessage.ai_response)` block.
        // This is for initial "interview_ready" or direct "next_question_prompt" messages.
        console.log("Initial question or direct prompt. Speaking:", serverMessage.current_question_text);
        speakText(serverMessage.current_question_text, "initial_or_direct_question")
            .then(() => {
                if (!isInterviewComplete) startAudioStreaming();
            })
            .catch(err => {
                console.error("TTS for initial_or_direct_question failed. Listening anyway.", err);
                if (!isInterviewComplete) startAudioStreaming();
            });
    } else if (serverMessage.action === "prompt_custom_question") {
        console.log("Server prompted to wait for custom questions.");
        document.getElementById("recordingStatus").textContent = "Please add custom questions to begin.";
    }
    // Further conditions or a switch statement on serverMessage.type or serverMessage.action could be useful.
}
