export class ScanLateAPI {
    static async getBaseUrl() {
        const res = await chrome.storage.local.get("serverUrl");
        return res.serverUrl || "http://127.0.0.1:8745";
    }

    static async getAccessKey() {
        const res = await chrome.storage.local.get("clientAccessKey");
        return res.clientAccessKey || "";
    }

    static async getStatus() {
        const baseUrl = await this.getBaseUrl();
        const accessKey = await this.getAccessKey();
        const headers = {
            "ngrok-skip-browser-warning": "true"
        };
        if (accessKey) headers["X-Access-Key"] = accessKey;

        try {
            const response = await fetch(`${baseUrl}/status`, {
                headers,
                signal: AbortSignal.timeout(10000),
                cache: "no-store"
            });
            if (response.ok) return await response.json();
            return { status: "offline" };
        } catch (e) {
            return { status: "offline" };
        }
    }

    static async getProfiles() {
        const baseUrl = await this.getBaseUrl();
        const accessKey = await this.getAccessKey();
        const headers = {
            "ngrok-skip-browser-warning": "true"
        };
        if (accessKey) headers["X-Access-Key"] = accessKey;

        try {
            const response = await fetch(`${baseUrl}/profiles`, { headers });
            if (response.ok) {
                const data = await response.json();
                return data.profiles || [];
            }
            return [];
        } catch (e) {
            return [];
        }
    }

    static async translateImageStream(imageBuffer, sourceLang, profileName, ocrModel, contextJson, imageIndex, totalImages, useMultimodal, useGeminiOcr, useAutoGlossary, dialogueOnly, ocrProvider, ocrModelSlug, ocrApiKey, llmProvider, llmModel, llmApiKey, callback, abortSignal) {
        const baseUrl = await this.getBaseUrl();
        const accessKey = await this.getAccessKey();
        const headers = {
            "ngrok-skip-browser-warning": "true"
        };
        if (accessKey) headers["X-Access-Key"] = accessKey;

        const formData = new FormData();
        const blob = new Blob([imageBuffer], { type: "image/jpeg" });
        formData.append("image", blob, "image.jpg");
        if (sourceLang) formData.append("source_lang", sourceLang);
        if (profileName) formData.append("profile_name", profileName);
        if (useMultimodal) formData.append("use_multimodal", "true");
        if (useGeminiOcr) formData.append("use_gemini_ocr", "true");
        if (useAutoGlossary) formData.append("use_auto_glossary", "true");
        if (dialogueOnly) formData.append("dialogue_only", "true");
        if (ocrModel) formData.append("ocr_model", ocrModel);
        if (contextJson) formData.append("context_json", contextJson);
        if (imageIndex !== undefined) formData.append("image_index", imageIndex.toString());
        if (totalImages !== undefined) formData.append("total_images", totalImages.toString());
        if (ocrProvider) formData.append("ocr_provider", ocrProvider);
        if (ocrModelSlug) formData.append("ocr_model_slug", ocrModelSlug);
        if (ocrApiKey) formData.append("ocr_api_key", ocrApiKey);
        if (llmProvider) formData.append("llm_provider", llmProvider);
        if (llmModel) formData.append("llm_model", llmModel);
        if (llmApiKey) formData.append("llm_api_key", llmApiKey);

        const response = await fetch(`${baseUrl}/translate/stream`, {
            method: "POST",
            headers,
            body: formData,
            signal: abortSignal
        });

        if (!response.ok) {
            throw new Error(`HTTP Error ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            
            let lines = buffer.split("\n\n");
            buffer = lines.pop();
            
            for (let line of lines) {
                if (line.startsWith("data: ")) {
                    const jsonStr = line.substring(6);
                    if (jsonStr.trim() === "") continue;
                    try {
                        const eventObj = JSON.parse(jsonStr);
                        callback(eventObj);
                    } catch (e) {
                        console.error("Failed to parse SSE JSON:", jsonStr);
                    }
                }
            }
        }
    }
}
