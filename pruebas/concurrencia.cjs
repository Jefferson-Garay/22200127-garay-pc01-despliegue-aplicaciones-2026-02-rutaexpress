const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sharedKey = `concurrente-${randomUUID()}`;
const newKeyA = `nuevo-${randomUUID()}`;
const newKeyB = `nuevo-${randomUUID()}`;

const body = {
  destinatario: "Cliente prueba concurrencia",
  direccion: "Direccion prueba concurrencia",
};

async function send(key, test) {
  const requestId = randomUUID();
  const start = new Date().toISOString();
  const clock = performance.now();

  try {
    const response = await fetch("http://localhost:8080/envios", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        "X-Request-ID": requestId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    const text = await response.text();
    let content;
    try {
      content = JSON.parse(text);
    } catch {
      content = { respuesta: text };
    }

    return {
      prueba: test,
      clave_operacion: key,
      request_id: requestId,
      inicio: start,
      fin: new Date().toISOString(),
      duracion_ms: Math.round(performance.now() - clock),
      http: response.status,
      instancia: response.headers.get("x-instance-id"),
      envio_id: content.id || null,
      cuerpo: content,
    };
  } catch (error) {
    return {
      prueba: test,
      clave_operacion: key,
      request_id: requestId,
      inicio: start,
      fin: new Date().toISOString(),
      duracion_ms: Math.round(performance.now() - clock),
      http: null,
      instancia: null,
      envio_id: null,
      error: error.name + ": " + error.message,
    };
  }
}

async function main() {
  fs.mkdirSync("evidencias", { recursive: true });

  // Iniciar ambas solicitudes sin esperar la respuesta de la primera.
  const simultaneous = await Promise.all([
    send(sharedKey, "Misma operacion A"),
    send(sharedKey, "Misma operacion B"),
  ]);

  await sleep(3000);

  // Mismos datos, pero dos claves que representan operaciones nuevas.
  const intentional = await Promise.all([
    send(newKeyA, "Operacion nueva A"),
    send(newKeyB, "Operacion nueva B"),
  ]);

  await sleep(300);

  const query = `
    SELECT json_build_object(
      'envios', (SELECT json_agg(e) FROM (
        SELECT id, clave_operacion, destinatario, direccion
        FROM envios
        WHERE clave_operacion IN ('${sharedKey}', '${newKeyA}', '${newKeyB}')
        ORDER BY id
      ) e),
      'intentos', (SELECT json_agg(i) FROM (
        SELECT request_id, clave_operacion, instancia,
               iniciado_en, procesado_en, resultado, envio_id,
               codigo_http_previsto, codigo_http_emitido
        FROM intentos
        WHERE clave_operacion IN ('${sharedKey}', '${newKeyA}', '${newKeyB}')
        ORDER BY id
      ) i)
    );
  `;

  const { stdout } = await execute("docker", [
    "compose", "exec", "-T", "db",
    "psql", "-U", "rutaexpress", "-d", "rutaexpress",
    "-t", "-A", "-c", query,
  ]);

  const database = JSON.parse(stdout.trim());
  const results = [...simultaneous, ...intentional];

  fs.writeFileSync(
    "evidencias/10-concurrencia.json",
    JSON.stringify({
      claves: { sharedKey, newKeyA, newKeyB },
      solicitudes: results,
      base_datos: database,
    }, null, 2)
  );

  console.table(results.map((result) => ({
    Prueba: result.prueba,
    HTTP: result.http,
    Instancia: result.instancia,
    Envio: result.envio_id,
  })));

  console.log("Envios guardados:");
  console.table(database.envios || []);

  console.log("Intentos registrados:");
  console.table((database.intentos || []).map((attempt) => ({
    Instancia: attempt.instancia,
    Resultado: attempt.resultado,
    Envio: attempt.envio_id,
    HTTP: attempt.codigo_http_emitido,
  })));

  console.log("Evidencia guardada: evidencias/10-concurrencia.json");
}

main().catch((error) => {
  console.error("La prueba no termino:", error.message);
  process.exitCode = 1;
});