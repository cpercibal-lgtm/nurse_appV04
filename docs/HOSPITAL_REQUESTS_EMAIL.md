# Hospital requests e-mail (English)

A ready-to-send follow-up to the go-live requests of 2026-10-17 ([HOSPITAL_OPEN_QUESTIONS.md §E](HOSPITAL_OPEN_QUESTIONS.md#e-needed-before-go-live)). Fill in the names in square brackets before sending. The Arabic version is [HOSPITAL_REQUESTS_EMAIL.ar.md](HOSPITAL_REQUESTS_EMAIL.ar.md). When an answer arrives, record it in the *Answer* column of HOSPITAL_OPEN_QUESTIONS.md, not here.

---

**Subject:** Nursing Workforce System: what we need from the hospital before go-live

Dear [Owner], [IT Director] and [Director of Nursing],

The Nursing Workforce Management System is built and tested. What remains before go-live depends on the hospital and its suppliers, not on the software. Some items take weeks, so I'd be grateful if they could start now.

Please answer each one with the facts asked for (a name, a date, a document) rather than "yes".

**1. The server (Owner and IT): needed before go-live; cannot be waived**

- The provider's name and the city of the data centre.
- The contract clause stating that the server, its backups and its snapshots stay inside the Kingdom.
- A storage bucket (S3-compatible), also inside the Kingdom, for the off-site backup copy.
- Size: 4 vCPU, 16 GB RAM, 200 GB disk, Ubuntu 24.04.

*Why:* staff personal data may only be stored in the Kingdom. Nothing can go live without this server.

**2. Credential rules, signed (Director of Nursing): needed before go-live; cannot be waived**

For each position, please list:

- which credentials it needs (SCFHS licence, BLS, ACLS, …);
- whether each is required or optional;
- how many days a nurse may keep working after one expires.

*Why:* the system decides who may be rostered from these rules. Today they are placeholders, so on day one it could block nurses who are allowed to work, or clear nurses who are not.

**3. SCFHS agreement (Owner)**

- Who at the hospital is applying, and the date the request went to SCFHS.
- When SCFHS provides it, their API documentation.

*Why:* until the agreement exists, the system does not check licences with SCFHS. HR checks each licence on the SCFHS website and records the result, with evidence, in the system. If the agreement isn't ready at go-live, the Owner can accept that in writing.

**4. Badge (clock-in) system (IT)**

- The vendor, the product name and a contact person.
- Can it send clock-ins to our system over HTTPS? If not, what can it provide: a file export, a database view, or its own interface?

*Why:* missed-shift alerts compare the roster with clock-ins. Everything else works without it. If it isn't ready at go-live, the Owner can accept that in writing.

**5. Telegram bot for alerts (IT, about 10 minutes)**

- Create the bot with @BotFather from a **hospital-owned** Telegram account, not a personal one.
- Give the bot's token to IT in person or through a password manager. **Please never send it by e-mail.**
- Ask the CEO and the IT Director each to start a chat with the bot.

*Why:* Telegram replaces SMS for alerts, including the alert when the emergency account is used.

**Also outstanding**

- **Hospital data questions:**
  - the 72 beds without a name;
  - the 281 vs 286 figure;
  - ICU Extension;
  - the Assistant Nurse licence;
  - questions C1, C2 and C5.
- **Arabic review:** a native Arabic speaker to read the roster approval screens and notices.
- **Shared internet address (IT):** do all staff reach the internet through one shared hospital address? If so, what is it? The system pauses sign-in after 20 failed attempts from one address within 15 minutes, so we may need to raise that limit for the hospital's address.

The full list, with space for answers, is in the project document *Hospital open questions*, section E. I'm happy to walk through any of it.

Kind regards,
[Your name]
[Role / contact]
