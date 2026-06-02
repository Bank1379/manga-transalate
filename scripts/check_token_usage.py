import asyncio
import os
import sys
import base64
import litellm
import argparse

# Dummy text and image for testing
DUMMY_TEXTS = [
    "お前はもう死んでいる",
    "なにぃ！？",
    "あたたたたたたたた！"
]

def create_dummy_image():
    # 10x10 white jpeg image in base64
    return "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAAKAAoBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="

async def check_tokens(model, texts, with_image):
    messages = [
        {"role": "system", "content": "You are a helpful manga translator. Translate the text to Thai."}
    ]
    
    user_content = []
    
    if with_image:
        b64_img = create_dummy_image()
        user_content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}
        })
        
    text_prompt = "Original Texts:\n"
    for i, t in enumerate(texts):
        text_prompt += f"[{i}] {t}\n"
        
    user_content.append({"type": "text", "text": text_prompt})
    
    messages.append({"role": "user", "content": user_content})
    
    print(f"--- Token Usage Check ({'Multimodal' if with_image else 'Text-only'}) ---")
    try:
        response = await litellm.acompletion(
            model=model,
            messages=messages,
            temperature=0,
            max_tokens=10 # Just to stop early and save costs if it actually runs, but we just want prompt tokens.
        )
        usage = response.usage
        print(f"Prompt Tokens: {usage.prompt_tokens}")
        print(f"Completion Tokens: {usage.completion_tokens}")
        print(f"Total Tokens: {usage.total_tokens}")
    except Exception as e:
        print(f"Error checking tokens: {e}")

async def main():
    parser = argparse.ArgumentParser(description="Check Token Usage Diff")
    parser.add_argument("--model", type=str, default="gemini/gemini-2.5-flash", help="LiteLLM model string")
    args = parser.parse_args()
    
    print(f"Model: {args.model}")
    print("\n1. Text-only translation:")
    await check_tokens(args.model, DUMMY_TEXTS, False)
    
    print("\n2. Multimodal translation (Text + Image):")
    await check_tokens(args.model, DUMMY_TEXTS, True)

if __name__ == "__main__":
    asyncio.run(main())
