# ScanLate v3

ScanLate เป็นระบบแปลการ์ตูน/มังงะแบบอัตโนมัติที่ช่วยให้คุณสามารถแปลหน้าเว็บมังงะภาษาต่างๆ (ญี่ปุ่น, เกาหลี, จีน, อังกฤษ) ให้เป็นภาษาไทยได้อย่างรวดเร็ว โดยทำงานผ่าน Chrome Extension ที่จะสแกนและแปลรูปภาพบนหน้าเว็บได้โดยตรง

ระบบออกแบบมาเป็น 2 ส่วนหลักคือ **Server Backend (Python)** และ **Chrome Extension**

## คุณสมบัติเด่น (Features)
- **แปลหน้าเว็บมังงะแบบ Real-time:** กดแปลได้โดยตรงบนหน้าเว็บไซต์ (เช่น Rawkuma, ฯลฯ)
- **AI Translation & Glossary:** ใช้พลังของ LLM (Gemini / OpenRouter) เพื่อแปลให้เป็นธรรมชาติ พร้อมระบบจัดการคำศัพท์เฉพาะ (Profile/Glossary)
- **Shared Extension:** มี Extension รุ่นพิเศษ (`extension_shared`) ที่คุณสามารถแจกให้เพื่อนใช้ได้ โดยคุณเป็นคนรัน Server และแจก Access Key ให้เพื่อน
- **Local Access Control:** สามารถจัดการและยกเลิก Access Key ของเพื่อนแต่ละคนได้ตลอดเวลาผ่านเมนู Settings ของ Extension หลัก
- **Force Stop:** มีปุ่มยกเลิกการแปลกลางคัน หากเปลี่ยนใจหรือไม่ต้องการรอ
- **VRAM & API Protection:** มีระบบจัดการคิวเพื่อป้องกันไม่ให้ VRAM การ์ดจอเต็ม และป้องกันการยิง API ถี่เกินไป (Rate Limit)

## วิธีการติดตั้งและรัน Server (สำหรับเจ้าของเครื่อง)
1. โคลน/ดาวน์โหลดโปรเจกต์นี้
2. รันสคริปต์ `scripts\setup.bat` เพื่อติดตั้ง Environment และ Dependencies ทั้งหมด
3. รันสคริปต์ `ScanLate.bat` เพื่อเปิดเซิร์ฟเวอร์
4. ระบบจะเปิดเซิร์ฟเวอร์ขึ้นมาที่ `http://127.0.0.1:8745` 

## วิธีติดตั้ง Extension (สำหรับเจ้าของเครื่อง)
1. เปิด Google Chrome แล้วไปที่ `chrome://extensions/`
2. เปิดโหมดนักพัฒนาซอฟต์แวร์ (Developer mode) ที่มุมขวาบน
3. คลิก **"โหลดส่วนขยายที่แยกไว้" (Load unpacked)**
4. เลือกโฟลเดอร์ `extension` ภายในโปรเจกต์นี้
5. คลิกปุ่ม ⚙️ (ตั้งค่า) ใน Extension เพื่อเข้าไปตั้งค่า API Key (เช่น Gemini หรือ OpenRouter) 

## การแบ่งปันให้เพื่อนใช้ (Shared Extension)
หากคุณต้องการให้เพื่อนใช้งานโดยใช้ API Key ของคุณ และประมวลผลผ่านการ์ดจอของคุณ:
1. เข้าไปที่ **Settings** ใน Extension หลักของคุณ ไปที่แท็บ **"แบ่งปันเซิร์ฟเวอร์"**
2. เพิ่มรายชื่อ Access Key สำหรับเพื่อน (เช่น `Friend1`, `John_Doe`)
3. ส่งโฟลเดอร์ `extension_shared` ให้เพื่อนติดตั้งแบบ Load unpacked
4. (สำหรับคุณ) ตั้งค่า Port Forwarding ใน Router เพื่อเปิดพอร์ต `8745` (TCP) ให้เป็น Public
5. (สำหรับเพื่อน) ให้เพื่อนกรอก **Public IP** (ตัวอย่าง `http://124.120.x.x:8745`) และ **Access Key** ที่หน้า Settings ของ Extension 

## ความปลอดภัย (Security)
- โปรเจกต์นี้ใช้ไฟล์ `.env` ในการเก็บความลับ (API Keys) ซึ่งไฟล์นี้จะไม่ถูกอัปโหลดขึ้น GitHub (`.gitignore` จัดการให้แล้ว)
- ระบบจัดการ Access Key ถูกควบคุมจากฝั่ง Server โดยหาก Access Key ไม่ถูกต้อง จะไม่สามารถเข้าใช้งานระบบได้ (Return HTTP 403 / 401)
- หากเพื่อนพยายามใช้ Ngrok หรือ VPN ระบบก็ยังสามารถตรวจจับและบล็อกได้ หาก Access Key ไม่ถูกต้อง

## โครงสร้างโปรเจกต์
- `server/`: โค้ดฝั่ง Backend (FastAPI, LLM Pipeline, API routes)
- `engine/`: โมดูล manga-image-translator สำหรับทำ OCR, ลบตัวอักษร, และวาดตัวอักษรทับ (Inpainting/Rendering)
- `extension/`: โค้ด Chrome Extension ตัวหลัก (มีสิทธิ์เปลี่ยน API Key ของ LLM และเพิ่ม Access Key)
- `extension_shared/`: โค้ด Chrome Extension ตัวแชร์ให้เพื่อน (เข้าถึงได้แค่การแปล โดยต้องใช้ Access Key)
- `data/`: เก็บ Cache, Profiles (คำศัพท์เฉพาะ), และ Fonts
