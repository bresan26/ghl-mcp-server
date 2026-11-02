import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const GHL_API_KEY   = process.env.GHL_API_KEY;
const LOCATION_ID   = process.env.GHL_LOCATION_ID;
const GHL_BASE      = 'https://services.leadconnectorhq.com';
const GHL_VERSION   = '2021-07-28';
const PORT          = process.env.PORT || 3000;

if (!GHL_API_KEY || !LOCATION_ID) {
  console.error('Missing env vars: GHL_API_KEY and GHL_LOCATION_ID are required.');
  process.exit(1);
}

async function ghl(method, path, body) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: GHL_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function buildServer() {
  const server = new McpServer({ name: 'ghl-novoideas', version: '1.0.0' });

  server.tool('buscar_contactos','Busca contactos en GHL por nombre, email o teléfono.',
    { query: z.string().describe('Nombre, email o teléfono a buscar') },
    async ({ query }) => {
      const data = await ghl('GET', `/contacts/?locationId=${LOCATION_ID}&query=${encodeURIComponent(query)}&limit=10`);
      const list = (data.contacts || []).map(c => ({ id: c.id, nombre: `${c.firstName||''} ${c.lastName||''}`.trim(), email: c.email, telefono: c.phone }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
  );

  server.tool('listar_tareas','Lista todas las tareas asignadas a un contacto de GHL.',
    { contactId: z.string() },
    async ({ contactId }) => {
      const data = await ghl('GET', `/contacts/${contactId}/tasks`);
      const tareas = (data.tasks || []).map(t => ({ id: t.id, titulo: t.title, vencimiento: t.dueDate, completada: t.completed, descripcion: t.body }));
      return { content: [{ type: 'text', text: JSON.stringify(tareas, null, 2) }] };
    }
  );

  server.tool('crear_tarea','Crea una nueva tarea en GHL para un contacto.',
    { contactId: z.string(), titulo: z.string(), vencimiento: z.string().describe('ISO date'), descripcion: z.string().optional(), asignadoA: z.string().optional() },
    async ({ contactId, titulo, vencimiento, descripcion, asignadoA }) => {
      const data = await ghl('POST', `/contacts/${contactId}/tasks`, { title: titulo, dueDate: vencimiento, completed: false, ...(descripcion && { body: descripcion }), ...(asignadoA && { assignedTo: asignadoA }) });
      return { content: [{ type: 'text', text: `Tarea creada: ${JSON.stringify(data, null, 2)}` }] };
    }
  );

  server.tool('completar_tarea','Marca una tarea de GHL como completada.',
    { contactId: z.string(), tareaId: z.string() },
    async ({ contactId, tareaId }) => {
      const data = await ghl('PUT', `/contacts/${contactId}/tasks/${tareaId}`, { completed: true });
      return { content: [{ type: 'text', text: `Tarea completada: ${JSON.stringify(data, null, 2)}` }] };
    }
  );

  server.tool('actualizar_tarea','Actualiza el título, fecha límite o descripción de una tarea.',
    { contactId: z.string(), tareaId: z.string(), titulo: z.string().optional(), vencimiento: z.string().optional(), descripcion: z.string().optional(), completada: z.boolean().optional() },
    async ({ contactId, tareaId, titulo, vencimiento, descripcion, completada }) => {
      const payload = { ...(titulo && { title: titulo }), ...(vencimiento && { dueDate: vencimiento }), ...(descripcion && { body: descripcion }), ...(completada !== undefined && { completed: completada }) };
      const data = await ghl('PUT', `/contacts/${contactId}/tasks/${tareaId}`, payload);
      return { content: [{ type: 'text', text: `Tarea actualizada: ${JSON.stringify(data, null, 2)}` }] };
    }
  );

  server.tool('eliminar_tarea','Elimina una tarea de GHL.',
    { contactId: z.string(), tareaId: z.string() },
    async ({ contactId, tareaId }) => {
      await ghl('DELETE', `/contacts/${contactId}/tasks/${tareaId}`);
      return { content: [{ type: 'text', text: 'Tarea eliminada correctamente.' }] };
    }
  );

  server.tool('tareas_pendientes','Lista las tareas pendientes de un contacto ordenadas por fecha.',
    { contactId: z.string() },
    async ({ contactId }) => {
      const data = await ghl('GET', `/contacts/${contactId}/tasks`);
      const pendientes = (data.tasks || []).filter(t => !t.completed).sort((a,b) => new Date(a.dueDate)-new Date(b.dueDate)).map(t => ({ id: t.id, titulo: t.title, vencimiento: t.dueDate, vencida: new Date(t.dueDate)<new Date(), descripcion: t.body }));
      return { content: [{ type: 'text', text: `${pendientes.length} tareas pendientes (${pendientes.filter(t=>t.vencida).length} vencidas):\n${JSON.stringify(pendientes, null, 2)}` }] };
    }
  );

  server.tool('buscar_oportunidades','Busca oportunidades/propuestas en GHL por nombre de contacto o título.',
    { query: z.string().optional().describe('Nombre del contacto o título'), contactId: z.string().optional().describe('ID del contacto') },
    async ({ query, contactId }) => {
      let url = `/opportunities/search?location_id=${LOCATION_ID}&limit=20`;
      if (query) url += `&q=${encodeURIComponent(query)}`;
      if (contactId) url += `&contact_id=${encodeURIComponent(contactId)}`;
      const data = await ghl('GET', url);
      const list = (data.opportunities || []).map(o => ({ id: o.id, nombre: o.name, estado: o.status, etapa: o.pipelineStage?.name, pipeline: o.pipeline?.name, contacto: o.contact?.name||'', valor: o.monetaryValue }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }
  );

  server.tool('cambiar_estado_oportunidad','Cambia el estado de una oportunidad: open, won, lost (declinada), abandoned.',
    { oportunidadId: z.string().describe('ID de la oportunidad'), estado: z.enum(['open','won','lost','abandoned']).describe('Nuevo estado') },
    async ({ oportunidadId, estado }) => {
      const data = await ghl('PUT', `/opportunities/${oportunidadId}/status`, { status: estado });
      return { content: [{ type: 'text', text: `Estado actualizado a "${estado}": ${JSON.stringify(data, null, 2)}` }] };
    }
  );

  server.tool('mover_oportunidad','Mueve una oportunidad a otra etapa del pipeline.',
    { oportunidadId: z.string(), etapaId: z.string().describe('ID de la nueva etapa'), nombre: z.string().optional(), valor: z.number().optional() },
    async ({ oportunidadId, etapaId, nombre, valor }) => {
      const payload = { pipelineStageId: etapaId, ...(nombre && { name: nombre }), ...(valor !== undefined && { monetaryValue: valor }) };
      const data = await ghl('PUT', `/opportunities/${oportunidadId}`, payload);
      return { content: [{ type: 'text', text: `Oportunidad actualizada: ${JSON.stringify(data, null, 2)}` }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', service: 'GHL MCP Server', location: LOCATION_ID }));

app.post('/mcp', async (req, res) => {
  try {
    const server    = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.delete('/mcp', (req, res) => res.status(405).end());
app.get('/mcp',    (req, res) => res.status(405).end());

app.listen(PORT, () => console.log(`GHL MCP Server — NOVOIDEAS — escuchando en :${PORT}`));
