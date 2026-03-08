# Auth routes

Telegram user authentication endpoints. All requests must include:

- **Header:** `api-key` — your application API key (same as `APPLICATION_API_KEY` in `.env`).
- **Header:** `Accept: application/json`

Responses use a common JSON shape: `{ success, message, data }`. On error, `success` is `false` and `message` contains the error description.

---

## POST `/auth/send-code`

Sends a one-time verification code to the given phone number (Telegram login flow). Use the returned `phoneCodeHash` and `session` in the next step (sign-in or resend-code).

**Request body (JSON)**

| Field         | Type   | Required | Description                                      |
|--------------|--------|----------|--------------------------------------------------|
| `phoneNumber`| string | Yes      | Phone number in international format (e.g. `+1234567890`) |

**Example**

```json
{
  "phoneNumber": "+1234567890"
}
```

**Response (200)**

| Field     | Type    | Description                    |
|----------|---------|--------------------------------|
| `success`| boolean | `true`                         |
| `message`| string  | e.g. `"Verification code sent"`|
| `data`   | array   | One object with:               |
| `data[0].phoneCodeHash` | string | Hash to use in sign-in / resend-code |
| `data[0].session`      | string | Session string; pass as `sessionCode` in sign-in and resend-code |

**Example**

```json
{
  "success": true,
  "message": "Verification code sent",
  "data": [
    {
      "phoneCodeHash": "abc123...",
      "session": "1BAAOMTQ5..."
    }
  ]
}
```

**Error (400)** — e.g. missing `phoneNumber` or Telegram API error (invalid number, etc.)  
`{ "success": false, "message": "<error message>", "data": [] }`

---

## POST `/auth/resend-code`

Resends the verification code using the same session that requested the original code. Use the `session` value returned from `POST /auth/send-code`.

**Request body (JSON)**

| Field          | Type   | Required | Description                                              |
|----------------|--------|----------|----------------------------------------------------------|
| `phoneNumber`  | string | Yes      | Same phone number used in send-code                      |
| `phoneCodeHash`| string | Yes      | Value from the send-code response                        |
| `sessionCode`  | string | Yes      | Session string from the send-code response               |

**Example**

```json
{
  "phoneNumber": "+1234567890",
  "phoneCodeHash": "abc123...",
  "sessionCode": "1BAAOMTQ5..."
}
```

**Response (200)**

| Field     | Type    | Description                         |
|----------|---------|-------------------------------------|
| `success`| boolean | `true`                              |
| `message`| string  | e.g. `"Verification code resent"`   |
| `data`   | array   | Result from Telegram (e.g. new `phoneCodeHash` if returned) |

**Error (400)** — e.g. missing fields or Telegram error (e.g. `PHONE_CODE_EXPIRED`)  
`{ "success": false, "message": "<error message>", "data": [] }`

---

## POST `/auth/sign-in`

Completes Telegram user login with the phone number, the code hash from send-code (or resend-code), and the verification code received by the user. Must use the same `sessionCode` returned from the send-code request that requested this code.

**Request body (JSON)**

| Field          | Type   | Required | Description                                              |
|----------------|--------|----------|----------------------------------------------------------|
| `phoneNumber`  | string | Yes      | Same phone number used in send-code                      |
| `phoneCodeHash`| string | Yes      | Value from the send-code (or resend-code) response       |
| `phoneCode`    | string | Yes      | The numeric code received via SMS or Telegram            |
| `sessionCode`  | string | Yes      | Session string from the send-code response               |

**Example**

```json
{
  "phoneNumber": "+1234567890",
  "phoneCodeHash": "abc123...",
  "phoneCode": "12345",
  "sessionCode": "1BAAOMTQ5..."
}
```

**Response (200)**

| Field     | Type    | Description                    |
|----------|---------|--------------------------------|
| `success`| boolean | `true`                         |
| `message`| string  | e.g. `"Signed in successfully"` |
| `data`   | array   | Telegram auth result (e.g. `auth.Authorization`) |

**Error (400)** — e.g. missing fields, wrong code, or Telegram error (`PHONE_CODE_EXPIRED`, `PHONE_CODE_INVALID`, etc.)  
`{ "success": false, "message": "<error message>", "data": [] }`

---

## Flow summary

1. **POST /auth/send-code** with `phoneNumber` → get `phoneCodeHash` and `session`.
2. User receives the code (SMS or Telegram).
3. **POST /auth/sign-in** with `phoneNumber`, `phoneCodeHash`, `phoneCode`, and `sessionCode` (the `session` from step 1).
4. If the code was not received, **POST /auth/resend-code** with `phoneNumber`, `phoneCodeHash`, and `sessionCode` (same session), then use the new code in step 3.

The same `sessionCode` must be used for both resend-code and sign-in that correspond to the same send-code request; otherwise Telegram may return `PHONE_CODE_EXPIRED`.
