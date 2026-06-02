import asyncio
import os
import json
import logging
import re
from typing import List
import litellm
from server import config
from server.llm import prompts
from server.profiles.manager import get_profile_manager

logger = logging.getLogger("ScanLate-LLM")

# Disable litellm logging noise in production
litellm.logging = False

class LLMClient:
    def __init__(self):
        self.provider = config.LLM_PROVIDER
        self.model = config.LLM_MODEL
        self._setup_keys()

    def update_config(self, provider: str, model: str, api_key: str = "", ollama_url: str = ""):
        """Hot-reload provider/model without server restart."""
        self.provider = provider
        self.model = model
        # Update config module globals so future clients/code paths read correct values
        config.LLM_PROVIDER = provider
        config.LLM_MODEL = model

        if provider == "gemini":
            config.GOOGLE_API_KEY = api_key
            os.environ["GEMINI_API_KEY"] = api_key
            os.environ["GOOGLE_API_KEY"] = api_key
        elif provider == "openrouter":
            config.OPENROUTER_API_KEY = api_key
            os.environ["OPENROUTER_API_KEY"] = api_key
        elif provider == "openai":
            os.environ["OPENAI_API_KEY"] = api_key
        elif provider == "ollama":
            config.OLLAMA_URL = ollama_url or "http://localhost:11434"

        # Save to .env persistently
        config.update_llm_config_env(provider, model, api_key, ollama_url)

        logger.info(f"LLM config updated: provider={provider}, model={model}")


    def _setup_keys(self):
        # Configure API Keys in environment for LiteLLM routing
        if config.GOOGLE_API_KEY:
            os.environ["GEMINI_API_KEY"] = config.GOOGLE_API_KEY
            os.environ["GOOGLE_API_KEY"] = config.GOOGLE_API_KEY
        if config.OPENROUTER_API_KEY:
            os.environ["OPENROUTER_API_KEY"] = config.OPENROUTER_API_KEY

    def _get_active_api_key(self):
        if self.provider == "gemini":
            return config.GOOGLE_API_KEY or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        elif self.provider == "openrouter":
            return config.OPENROUTER_API_KEY or os.environ.get("OPENROUTER_API_KEY")
        elif self.provider == "openai":
            return os.environ.get("OPENAI_API_KEY")
        return None

    def _resolve_model_string(self) -> str:
        """
        Return the correct LiteLLM model string for the current provider.

        LiteLLM auto-detects provider from the model prefix — so if a user
        sets model='deepseek-v4-flash:free' with provider='openrouter', LiteLLM
        would wrongly route it to the Deepseek provider (no OpenRouter key).

        Rules:
          openrouter  → "openrouter/<slug>"   (unless already prefixed)
          gemini      → "gemini/<slug>"        (unless already prefixed)
          openai      → slug as-is (gpt-*, o1-*, etc.)
          ollama      → "ollama_chat/<slug>"   (unless already prefixed)
        """
        model = self.model.strip()
        provider = self.provider

        if provider == "openrouter":
            if not model.startswith("openrouter/"):
                model = f"openrouter/{model}"

        elif provider == "gemini":
            if not model.startswith("gemini/"):
                model = f"gemini/{model}"

        elif provider == "ollama":
            # ollama_chat/ prefix triggers LiteLLM's Ollama chat completions endpoint
            if not model.startswith("ollama/") and not model.startswith("ollama_chat/"):
                model = f"ollama_chat/{model}"

        # openai: model slugs like gpt-4o, gpt-4o-mini are auto-detected correctly

        logger.debug(f"Resolved model string: '{self.model}' → '{model}' (provider={provider})")
        return model

    async def translate_texts(self, texts: List[str], source_lang: str, profile_name: str = None, page_context: str = "", image_bytes: bytes = None) -> List[str]:
        """
        Translates a list of strings using LiteLLM.
        Injects the profile glossary/context and returns a list of translated Thai strings in the same order.
        """
        if not texts:
            return []

        # Remove empty texts or whitespace-only but keep positions mapping
        cleaned_texts = []
        mapping = []
        for i, t in enumerate(texts):
            stripped = t.strip()
            if stripped:
                cleaned_texts.append(stripped)
                mapping.append(i)
        
        if not cleaned_texts:
            return ["" for _ in texts]

        # Fetch profile context
        profile_context = ""
        if profile_name:
            pm = get_profile_manager()
            profile_context = pm.get_profile_content(profile_name)

        # Build Prompts
        system_prompt = prompts.build_system_prompt(source_lang, profile_context, page_context)
        user_prompt = prompts.build_user_prompt(cleaned_texts)

        user_content = [{"type": "text", "text": user_prompt}]
        if image_bytes:
            import base64
            b64_img = base64.b64encode(image_bytes).decode('utf-8')
            user_content.insert(0, {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}
            })

        # Output template mapping
        translated_cleaned = []
        
        try:
            logger.info(f"Invoking LLM translation via LiteLLM ({self.model}) for {len(cleaned_texts)} blocks...")
            
            # Setup custom API URL if Ollama is selected
            api_base = None
            if self.provider == "ollama":
                api_base = config.OLLAMA_URL

            # Normalize model string so LiteLLM routes to the correct provider.
            # LiteLLM auto-detects provider from the model prefix, so we must
            # ensure the slug is prefixed correctly for each provider.
            model_str = self._resolve_model_string()
            
            # Refresh API keys from configuration dynamically
            self._setup_keys()
            
            # We enforce JSON mode if supported by model, or guide via prompt
            response = await litellm.acompletion(
                model=model_str,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content}
                ],
                api_base=api_base,
                response_format={"type": "json_object"} if self.provider in ("gemini", "openai") else None,
                temperature=0.2,
                timeout=30.0
            )

            response_text = response.choices[0].message.content.strip()
            
            # Parse JSON
            translated_cleaned = self._parse_llm_json_response(response_text, len(cleaned_texts))
            
        except litellm.RateLimitError as e:
            retry_wait = self._extract_retry_delay(e)
            if retry_wait > 0:
                logger.warning(
                    f"Rate limit hit. Waiting {retry_wait:.1f}s then retrying batch... "
                    f"(model={model_str})"
                )
                await asyncio.sleep(retry_wait)
                try:
                    response = await litellm.acompletion(
                        model=model_str,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_content}
                        ],
                        api_base=api_base,
                        response_format={"type": "json_object"} if self.provider in ("gemini", "openai") else None,
                        temperature=0.2,
                        timeout=30.0
                    )
                    response_text = response.choices[0].message.content.strip()
                    translated_cleaned = self._parse_llm_json_response(response_text, len(cleaned_texts))
                except Exception as retry_err:
                    logger.error(f"Retry after rate limit also failed: {retry_err}")
                    # Return original texts — do NOT fallback per-block (wastes quota)
                    translated_cleaned = list(cleaned_texts)
            else:
                # No retry delay info → daily quota exhausted, don't waste more calls
                logger.error(
                    f"Rate limit exceeded (likely daily quota). "
                    f"Returning original texts to avoid wasting quota. Error: {e}"
                )
                translated_cleaned = list(cleaned_texts)

        except Exception as e:
            logger.error(f"LiteLLM completion failed: {e}. Falling back to individual translation...")
            # Fallback to translate line-by-line in case of non-rate-limit failures
            translated_cleaned = await self._fallback_translate_individually(cleaned_texts, system_prompt)

        # Map back to original list length with empty slots preserved
        final_translations = ["" for _ in texts]
        for clean_idx, orig_idx in enumerate(mapping):
            if clean_idx < len(translated_cleaned):
                final_translations[orig_idx] = translated_cleaned[clean_idx]
            else:
                # If list length mismatch, fallback to original text
                final_translations[orig_idx] = texts[orig_idx]

        return final_translations

    async def stream_translate_texts(self, texts: List[str], source_lang: str, profile_name: str = "default", context_texts: List[str] = None, image_bytes: bytes = None):
        """
        Streams translated texts one by one as they are generated by the LLM.
        Yields JSON strings containing: {"index": <original_index>, "text": <translated_text>}
        """
        # Filter empty strings and map back
        cleaned_texts = []
        mapping = []
        for i, t in enumerate(texts):
            stripped = t.strip()
            if stripped and stripped.lower() not in ["", ".", "..", "...", "-", "_", "?", "!"]:
                cleaned_texts.append(stripped)
                mapping.append(i)

        # Early return if nothing to translate
        if not cleaned_texts:
            return

        # Prepare prompts
        pm = get_profile_manager()
        profile_context = ""
        page_context = ""
        if context_texts:
            page_context = "\n".join([f"- {t}" for t in context_texts])
        if profile_name and profile_name.lower() != "default":
            profile_context = pm.get_profile_content(profile_name)

        system_prompt = prompts.build_system_prompt(source_lang, profile_context, page_context)
        user_prompt = prompts.build_user_prompt(cleaned_texts)

        user_content = [{"type": "text", "text": user_prompt}]
        if image_bytes:
            import base64
            b64_img = base64.b64encode(image_bytes).decode('utf-8')
            user_content.insert(0, {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}
            })

        try:
            logger.info(f"Invoking LLM translation STREAM via LiteLLM ({self.model}) for {len(cleaned_texts)} blocks...")
            
            api_base = config.OLLAMA_URL if self.provider == "ollama" else None
            model_str = self._resolve_model_string()
            self._setup_keys()
            active_key = self._get_active_api_key()
            
            completion_kwargs = {
                "model": model_str,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content}
                ],
                "temperature": 0.2,
                "timeout": 30.0,
                "stream": True,
            }
            if api_base:
                completion_kwargs["api_base"] = api_base
            if active_key:
                completion_kwargs["api_key"] = active_key
            if self.provider in ("gemini", "openai"):
                completion_kwargs["response_format"] = {"type": "json_object"}

            max_retries = 3
            for attempt in range(max_retries):
                try:
                    response = await litellm.acompletion(**completion_kwargs)

                    # Simple streaming JSON array/object parser
                    in_string = False
                    escape = False
                    current_string = []
                    clean_idx = 0

                    async for chunk in response:
                        content = chunk.choices[0].delta.content
                        if not content:
                            continue
                        
                        for char in content:
                            if not in_string:
                                if char == '"':
                                    in_string = True
                                    current_string = []
                            else:
                                if escape:
                                    current_string.append(char)
                                    escape = False
                                elif char == '\\':
                                    current_string.append(char)
                                    escape = True
                                elif char == '"':
                                    in_string = False
                                    try:
                                        parsed_str = json.loads('"' + "".join(current_string) + '"')
                                        if str(clean_idx) == parsed_str:
                                            continue
                                        
                                        if clean_idx < len(mapping):
                                            orig_idx = mapping[clean_idx]
                                            yield json.dumps({"index": orig_idx, "text": parsed_str})
                                        clean_idx += 1
                                    except Exception:
                                        pass
                                else:
                                    current_string.append(char)
                    
                    # If we complete the stream successfully, exit the retry loop
                    break
                    
                except Exception as e:
                    # Unwrap litellm exceptions
                    actual_error = e
                    if hasattr(e, 'original_exception') and e.original_exception:
                        actual_error = e.original_exception
                        
                    err_str = str(e)
                    if "RateLimitError" in err_str or "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                        retry_wait = self._extract_retry_delay(e)
                        if retry_wait > 0 and attempt < max_retries - 1:
                            logger.warning(f"Rate limit hit during stream. Waiting {retry_wait:.1f}s then retrying... (Attempt {attempt+1}/{max_retries})")
                            await asyncio.sleep(retry_wait)
                            continue
                            
                    logger.error(f"Streaming LLM failed: {e}")
                    yield json.dumps({"error": str(e)})
                    break
                            
        except Exception as e:
            logger.error(f"Streaming setup failed: {e}")
            yield json.dumps({"error": str(e)})

    def _extract_retry_delay(self, error: Exception) -> float:
        """
        Parse the retryDelay from a 429 RateLimitError response.
        Returns seconds to wait, or 0 if not found / too long (no point retrying).
        """
        try:
            err_str = str(error)
            delay = 0.0
            
            # Extract retryDelay value like "retryDelay": "22s"
            m = re.search(r'"retryDelay"\s*:\s*"([\d.]+)s"', err_str)
            if m:
                delay = float(m.group(1)) + 1.0  # add 1s buffer
            else:
                # Try numeric field
                m2 = re.search(r'retry[_ ]delay["\s:]+([\d.]+)', err_str, re.IGNORECASE)
                if m2:
                    delay = float(m2.group(1)) + 1.0
            
            # Only wait if delay is reasonable (e.g. <= 120 seconds).
            # If it's longer or 0, we'll just abort by returning 0.0.
            if delay > 0 and delay <= 120.0:
                return delay
                
        except Exception:
            pass
        return 0.0

    # ──────────────────────────────────────────────────────────────────────

    def _parse_llm_json_response(self, text: str, expected_count: int) -> List[str]:
        # Strip potential markdown formatting wraps if model ignores response_format
        if text.startswith("```json"):
            text = text[7:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

        try:
            data = json.loads(text)
            # The model might return a list directly or a dictionary containing a list
            if isinstance(data, list):
                parsed = [str(item) for item in data]
            elif isinstance(data, dict):
                # Search for any list inside the dictionary
                parsed = []
                for val in data.values():
                    if isinstance(val, list):
                        parsed = [str(item) for item in val]
                        break
                if not parsed:
                    # If it's a simple key-value dictionary, we try sorting key or extract values
                    parsed = [str(v) for v in data.values()]
            else:
                parsed = [str(data)]
                
            # Pad or trim to match expected count
            if len(parsed) != expected_count:
                logger.warning(f"LLM returned {len(parsed)} translations, expected {expected_count}. Padding...")
                while len(parsed) < expected_count:
                    parsed.append("")
                parsed = parsed[:expected_count]
                
            return parsed
            
        except Exception as e:
            logger.error(f"Failed to parse LLM response as JSON: {e}. Content: {text}")
            raise e

    async def _fallback_translate_individually(self, texts: List[str], system_prompt: str) -> List[str]:
        results = []
        for text in texts:
            try:
                # Direct simple translation for single text
                user_prompt = f"แปลข้อความต่อไปนี้เป็นภาษาไทย โดยส่งกลับเฉพาะคำแปลเท่านั้น:\n\"{text}\""
                api_base = config.OLLAMA_URL if self.provider == "ollama" else None
                
                response = await litellm.acompletion(
                    model=self._resolve_model_string(),
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    api_base=api_base,
                    temperature=0.2,
                    timeout=10.0
                )
                translated = response.choices[0].message.content.strip()
                # Clean up any potential wraps
                if translated.startswith('"') and translated.endswith('"'):
                    translated = translated[1:-1]
                results.append(translated)
            except litellm.RateLimitError as e:
                # Stop immediately — retrying more blocks won't help, saves quota
                retry_wait = self._extract_retry_delay(e)
                logger.warning(
                    f"Rate limit in fallback (retry_wait={retry_wait:.0f}s). "
                    f"Aborting fallback for remaining {len(texts) - len(results)} blocks."
                )
                # Pad remaining with original text
                results.append(text)
                remaining = texts[len(results):]
                results.extend(remaining)
                break
            except Exception as e:
                logger.error(f"Fallback translation failed for '{text}': {e}")
                # Use original text as last resort
                results.append(text)
        return results

    # Circuit-breaker: track when quota was last exhausted to skip glossary attempts
    _glossary_rate_limited_until: float = 0.0

    async def extract_and_update_glossary(self, original_texts: List[str], translated_texts: List[str], profile_name: str) -> List[dict]:
        """Extracts glossary terms from the translations and updates the profile asynchronously.
        Runs silently in the background — never raises, never blocks translation.
        """
        import time
        
        if not original_texts or not translated_texts or not profile_name or profile_name == "default":
            return []
        
        # Circuit-breaker: if quota was recently exhausted, skip silently
        if time.time() < LLMClient._glossary_rate_limited_until:
            remaining = int(LLMClient._glossary_rate_limited_until - time.time())
            logger.debug(f"Auto Glossary: Skipping (quota cooldown {remaining}s remaining).")
            return []
            
        system_prompt = (
            "You are a helpful assistant that extracts glossary terms from manga translations. "
            "Given the original text and its translation, extract ONLY character names, locations, special moves, or unique terminology. "
            "Return a JSON array of objects with keys: 'term' (original text), 'translation' (Thai), and 'context' (brief explanation). "
            "If no such terms exist, return an empty array []."
        )
        
        user_prompt = "Original Texts:\n"
        for idx, t in enumerate(original_texts):
            if t.strip():
                user_prompt += f"[{idx}] {t.strip()}\n"
                
        user_prompt += "\nTranslated Texts:\n"
        for idx, t in enumerate(translated_texts):
            if t.strip():
                user_prompt += f"[{idx}] {t.strip()}\n"
                
        try:
            model_str = self._resolve_model_string()
            api_base = config.OLLAMA_URL if self.provider == "ollama" else None
            model_str = self._resolve_model_string()
            self._setup_keys()
            active_key = self._get_active_api_key()
            
            completion_kwargs = {
                "model": model_str,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "temperature": 0.1,
                "timeout": 20.0,
            }
            if api_base:
                completion_kwargs["api_base"] = api_base
            if active_key:
                completion_kwargs["api_key"] = active_key
            if self.provider in ("gemini", "openai"):
                completion_kwargs["response_format"] = {"type": "json_object"}
            
            response = await litellm.acompletion(**completion_kwargs)
            
            response_text = response.choices[0].message.content.strip()
            # Find JSON array using regex if not perfectly formatted
            import re
            import json
            match = re.search(r'\[.*\]', response_text, re.DOTALL)
            terms = []
            if match:
                terms = json.loads(match.group(0))
            else:
                try:
                    terms = json.loads(response_text)
                    if isinstance(terms, dict) and "terms" in terms:
                        terms = terms["terms"]
                except Exception:
                    pass
                    
            if isinstance(terms, list) and len(terms) > 0:
                # Basic validation
                valid_terms = [t for t in terms if isinstance(t, dict) and "term" in t and "translation" in t]
                if valid_terms:
                    pm = get_profile_manager()
                    pm.append_glossary_terms(profile_name, valid_terms)
                    logger.info(f"Auto Glossary: Added terms to profile '{profile_name}'.")
                    return valid_terms
                    
        except litellm.RateLimitError as e:
            # Quota exhausted — set circuit-breaker, skip quietly
            retry_wait = self._extract_retry_delay(e)
            cooldown = max(retry_wait, 60.0)  # Wait at least 60s before trying again
            LLMClient._glossary_rate_limited_until = time.time() + cooldown
            logger.debug(f"Auto Glossary: Rate limit hit. Pausing glossary for {cooldown:.0f}s (quota preserved for translation).")
        except Exception as e:
            # Any other error — swallow silently, never disrupt translation
            logger.debug(f"Auto Glossary: Skipped due to error: {type(e).__name__}")
            
        return []

_llm_client = None

def get_llm_client() -> LLMClient:
    global _llm_client
    if _llm_client is None:
        _llm_client = LLMClient()
    return _llm_client

def reset_llm_client():
    """Force recreation of the singleton on next call (used after settings update)."""
    global _llm_client
    _llm_client = None
