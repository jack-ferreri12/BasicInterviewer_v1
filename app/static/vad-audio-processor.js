// app/static/vad-audio-processor.js

// VAD_FRAME_DURATION_MS and AUDIO_SAMPLE_RATE must match the main script's constants.
// We'll make them configurable via processor options when the worklet is instantiated.

class VADAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.sampleRate = options.processorOptions.sampleRate || 16000;
        this.frameDurationMs = options.processorOptions.frameDurationMs || 20;
        
        // Calculate samples per VAD frame: SampleRate * Duration_sec
        this.samplesPerFrame = this.sampleRate * (this.frameDurationMs / 1000);
        // Bytes per VAD frame (Int16 PCM = 2 bytes per sample)
        this.bytesPerFrame = this.samplesPerFrame * 2;

        this._internalBuffer = new Int16Array(0);
        this.port.onmessage = this.handleMessage.bind(this);
        this.active = true;
        this.paused = false; // New flag to pause without fully stopping

        console.log(`[VADAudioProcessor] Constructed. Expected SR: ${this.sampleRate}, FD: ${this.frameDurationMs}ms. Calculated samplesPerFrame: ${this.samplesPerFrame}, calculated bytesPerFrame: ${this.bytesPerFrame}`);
    }

    handleMessage(event) {
        if (event.data === 'stop') {
            this.active = false;
            this.paused = false;
            this._internalBuffer = new Int16Array(0); // Clear buffer on stop
            console.log("[VADAudioProcessor] Stop message received. Processor will no longer send audio data. Buffer cleared.");
        } else if (event.data === 'pause') {
            this.paused = true;
            console.log("[VADAudioProcessor] Pause message received. Processor will collect but not send audio data.");
        } else if (event.data === 'resume') {
            this.paused = false;
            console.log("[VADAudioProcessor] Resume message received. Processor will resume sending audio data.");
        }
    }

    process(inputs, outputs, parameters) {
        // If not active, do nothing further and keep the processor running
        if (!this.active) {
            return true; 
        }

        // Inputs contains an array of inputs, each input is an array of channels,
        // and each channel is a Float32Array of audio samples.
        // We expect mono input, so we take inputs[0][0].
        const inputChannelData = inputs[0] && inputs[0][0];

        if (inputChannelData) {
            // Convert Float32 to Int16 PCM and append to our internal buffer
            let newPcmInt16 = new Int16Array(inputChannelData.length);
            for (let i = 0; i < inputChannelData.length; i++) {
                let val = Math.max(-1, Math.min(1, inputChannelData[i]));
                newPcmInt16[i] = val * 0x7FFF; // 0x7FFF is 32767
            }

            const oldInternalBufferLength = this._internalBuffer.length;
            let temp = new Int16Array(oldInternalBufferLength + newPcmInt16.length);
            temp.set(this._internalBuffer, 0);
            temp.set(newPcmInt16, oldInternalBufferLength);
            this._internalBuffer = temp;

            // Process in samplesPerFrame (Int16) chunks, but only send if not paused
            while (this.active && this._internalBuffer.length >= this.samplesPerFrame) {
                const chunkInt16 = this._internalBuffer.subarray(0, this.samplesPerFrame);
                const remainingInt16 = this._internalBuffer.subarray(this.samplesPerFrame);
                
                this._internalBuffer = remainingInt16;

                // Only send if not paused
                if (!this.paused) {
                    // Force creation of a new ArrayBuffer with EXACTLY the right size
                    const forcedSizeArray = new Int16Array(this.samplesPerFrame);
                    forcedSizeArray.set(chunkInt16);
                    const bufferToSend = forcedSizeArray.buffer;
                    
                    console.log(`[VADAudioProcessor] Posting chunk. chunkInt16.length: ${chunkInt16.length}, bufferToSend.byteLength: ${bufferToSend.byteLength}. Expected bytesPerFrame: ${this.bytesPerFrame}`);

                    this.port.postMessage(bufferToSend);
                } else {
                    // We're paused - log less frequently to avoid console spam
                    if (Math.random() < 0.05) { // Only log ~5% of frames when paused
                        console.log("[VADAudioProcessor] Chunk processed but NOT sent (paused mode)");
                    }
                }
            }
        }
        
        // Keep processor alive
        return this.active;
    }
}

registerProcessor('vad-audio-processor', VADAudioProcessor); 