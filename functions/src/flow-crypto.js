const crypto = require("crypto");

function normalizeFlowPrivateKey(value) {
  const pem = String(value || '').replace(/\\n/g, '\n').trim();
  try {
    if (!/^-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) throw new Error('Formato inválido');
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error('Chave RSA inválida');
    return pem;
  } catch {
    throw new Error('WHATSAPP_FLOW_PRIVATE_KEY deve conter a chave privada RSA completa em formato PEM, incluindo BEGIN PRIVATE KEY e END PRIVATE KEY. Copie o valor do segredo usado pelo endpoint da barbearia.');
  }
}

function decryptFlowRequest(body, privateKeyPem, passphrase = undefined) {
  const encryptedAesKey = requiredBase64(body?.encrypted_aes_key, "encrypted_aes_key");
  const encryptedFlowData = requiredBase64(body?.encrypted_flow_data, "encrypted_flow_data");
  const initialVector = requiredBase64(body?.initial_vector, "initial_vector");

  const aesKey = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      passphrase: passphrase || undefined,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    encryptedAesKey
  );

  if (encryptedFlowData.length < 17) {
    throw new Error("encrypted_flow_data inválido");
  }

  const authTag = encryptedFlowData.subarray(encryptedFlowData.length - 16);
  const ciphertext = encryptedFlowData.subarray(0, encryptedFlowData.length - 16);
  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, initialVector);
  decipher.setAuthTag(authTag);
  const clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return {
    aesKey,
    initialVector,
    payload: JSON.parse(clear.toString("utf8")),
  };
}

function encryptFlowResponse(payload, aesKey, initialVector) {
  const flippedIv = Buffer.from(initialVector.map((byte) => byte ^ 0xff));
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64");
}

function requiredBase64(value, name) {
  if (!value || typeof value !== "string") {
    throw new Error(`${name} não informado`);
  }
  return Buffer.from(value, "base64");
}

module.exports = {
  normalizeFlowPrivateKey,
  decryptFlowRequest,
  encryptFlowResponse,
};
