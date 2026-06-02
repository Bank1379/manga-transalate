SYSTEM_PROMPT_TEMPLATE = """
คุณเป็นนักแปลมังงะและนักแต่งคำแปล (Scanlation Typesetter/Translator) มืออาชีพ
ภารกิจของคุณคือการแปลข้อความจากมังงะภาษาต้นทาง ({source_lang}) เป็นภาษาไทย ({target_lang})

## กฎการแปลและการทำงาน:
{rules_text}

## ข้อมูลเฉพาะของมังงะเรื่องนี้ (Series Profile):
{profile_context}

## ข้อมูลบริบทรอบข้าง (Context from adjacent pages):
{page_context}

คุณจะได้รับรายการข้อความต้นฉบับที่ต้องแปลในรูปแบบ JSON Array จงตอบกลับเป็น JSON Array ของคำแปลภาษาไทยที่มีจำนวนแถวและลำดับตรงกับอินพุตเป้าหมาย 100% โดยไม่ต้องพิมพ์คำอธิบายอื่นใดนอกเหนือจาก JSON ผลลัพธ์
"""

USER_PROMPT_TEMPLATE = """
แปลรายการข้อความต่อไปนี้เป็นภาษาไทย:
{text_list_json}
"""

def build_system_prompt(source_lang: str, profile_context: str = "", page_context: str = "") -> str:
    target_lang = "ไทย"
    
    # Map abbreviation to full name
    lang_names = {
        "ja": "ญี่ปุ่น",
        "ko": "เกาหลี",
        "zh": "จีน",
        "en": "อังกฤษ",
        "auto": "ใดๆ (วิเคราะห์อัตโนมัติ เช่น ญี่ปุ่น เกาหลี หรือจีน)"
    }
    src_full = lang_names.get(source_lang.lower(), source_lang)
    
    # Base prompt rules
    rules = [
        "1. แปลให้สละสลวยเป็นธรรมชาติในภาษาไทย หลีกเลี่ยงการแปลแบบตรงตัว (Literal Translation) ที่อ่านแล้วขัดหู",
        "2. ข้อความแปลจะต้องสั้น กระชับ และได้ใจความ เพื่อให้พอดีกับช่องคำพูด (Speech Bubble) ดั้งเดิม",
        "3. รักษาโทนเสียงและลักษณะนิสัยของตัวละครแต่ละตัวตามที่ระบุใน Profile (เช่น การใช้สรรพนาม กู/มึง, ข้า/เจ้า, ผม/คุณ)",
        "4. ห้ามแต่งเติมข้อมูลที่ไม่มีอยู่จริงในข้อความต้นฉบับ หรือใส่ความเห็นของผู้แปล",
        "5. ถ้าเป็นข้อความประเภทเสียงประกอบ (SFX / Onomatopoeia) ให้แปลเป็นคำบรรยายเสียงภาษาไทยสั้นๆ ที่เหมาะสม"
    ]
    
    if source_lang.lower() == "auto":
        rules.append('6. **สำคัญ:** คุณอยู่ในโหมด Auto-Detect หากเจอข้อความขยะ (Garbage characters), สัญลักษณ์แปลกๆ, ลวดลายภาพที่ถูกอ่านมาผิดพลาด หรือข้อความที่อ่านไม่เป็นภาษา ให้แปลเป็นค่าว่าง (Empty String `""`) ทันทีเพื่อป้องกันการแปลมั่ว')
    
    rules_text = "\n".join(rules)
    
    return SYSTEM_PROMPT_TEMPLATE.format(
        source_lang=src_full,
        target_lang=target_lang,
        rules_text=rules_text,
        profile_context=profile_context if profile_context else "ไม่มีเงื่อนไขศัพท์เฉพาะหรือประวัติตัวละคร",
        page_context=page_context if page_context else "ไม่มีข้อมูลหน้าก่อนหน้า"
    )

def build_user_prompt(text_list: list) -> str:
    import json
    return USER_PROMPT_TEMPLATE.format(
        text_list_json=json.dumps(text_list, ensure_ascii=False, indent=2)
    )
