console.log("🔥 JS LOADED:", window.location.pathname);

document.addEventListener("DOMContentLoaded", () => {
    console.log("✅ DOM ready:", window.location.pathname);

    // TEMP: comment this out if you're not sure about pathname
    if (window.location.pathname !== "/popular") {
        console.warn("🚫 Not on /popular page, exiting script.");
        return;
    }

    const cards = document.querySelectorAll('.preset-card');
    console.log(`🎯 Found ${cards.length} preset cards`);

    cards.forEach(card => {
        card.addEventListener('click', async () => {
            const presetId = card.dataset.id;
            console.log("🟢 Clicked card:", presetId);

            try {
                const response = await fetch(`/load_preset/${presetId}`);
                const data = await response.json();

                if (data.questions && data.questions.length > 0) {
                    localStorage.setItem("presetQuestions", JSON.stringify(data.questions));
                    window.location.href = "/";
                } else {
                    alert("No questions found for this preset.");
                }
            } catch (err) {
                console.error("❌ Failed to load preset:", err);
                alert("Something went wrong while loading this interview.");
            }
        });
    });
});
