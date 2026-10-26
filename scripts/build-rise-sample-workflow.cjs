// Builds the credential-free n8n export and exposes its transformations for offline tests.
const fs = require('node:fs');
const path = require('node:path');

function initialize() {
  return {
    stage: 'employees', page: 1, pageSize: 100, expectedCount: null,
    employeeIds: [], employeeIndex: 0, currentRequestIds: [],
    requests: [], rawRequestPages: [], employeeResults: [],
    startedAt: new Date().toISOString(),
  };
}

function prepare(state) {
  if (!['employees', 'requests'].includes(state.stage)) throw new Error('No page to collect.');
  if (!Number.isInteger(state.page) || state.page < 1 || state.page > 10000) {
    throw new Error('Invalid page number or inspection page safety limit exceeded.');
  }
  const query = `page%5Bnumber%5D=${state.page}&page%5Bsize%5D=${state.pageSize}`;
  const resource = state.stage === 'employees' ? 'employees' : 'time_off_requests';
  const employeeId = state.employeeIds[state.employeeIndex];
  if (state.stage === 'requests' && !/^\d+$/.test(employeeId || '')) {
    throw new Error('Missing numeric employee resource ID.');
  }
  return {
    ...state,
    requestUrl: `https://api.risepeople.com/v1/${resource}?${query}` +
      (state.stage === 'requests' ? `&employee_id=${employeeId}` : ''),
  };
}

function processPage(previous, response) {
  // No error-body or short-page interpretation can silently turn into a complete scan.
  const state = JSON.parse(JSON.stringify(previous));
  const body = response.body;
  if (response.statusCode !== 200 || !body || !Array.isArray(body.data)) {
    throw new Error('Expected HTTP 200 with a JSON:API data array; collection is incomplete.');
  }
  const count = body.meta?.count;
  if (!Number.isInteger(count) || count < 0 || body.data.length > state.pageSize) {
    throw new Error('Missing/invalid meta.count or oversized page; inspect the actual API response.');
  }
  if (state.expectedCount !== null && count !== state.expectedCount) {
    throw new Error('Collection total changed during pagination; rerun the inspection.');
  }
  state.expectedCount = count;
  const seen = state.stage === 'employees' ? state.employeeIds : state.currentRequestIds;
  const employeeId = state.employeeIds[state.employeeIndex];
  for (const row of body.data) {
    if (!row || typeof row.id !== 'string' || !/^\d+$/.test(row.id)) {
      throw new Error('Expected a numeric string resource ID.');
    }
    if (seen.includes(row.id)) throw new Error('Repeated resource ID across pages; collection is unstable.');
    if (state.stage === 'requests') {
      if (row.type !== 'time_off_requests' || String(row.attributes?.employee_id) !== employeeId) {
        throw new Error('Request identity does not match the employee being collected.');
      }
      if (state.requests.some(existing => existing.id === row.id)) {
        throw new Error('Request ID was returned for more than one employee.');
      }
      state.requests.push(row);
    } else if (row.type !== 'employees') {
      throw new Error('Expected an employee resource.');
    }
    seen.push(row.id);
  }
  if (state.stage === 'requests') {
    state.rawRequestPages.push({
      employee_id: employeeId, page: state.page,
      retrieved_at: new Date().toISOString(),
      request_id: response.headers?.['x-request-id'] ?? response.headers?.['X-Request-Id'] ?? null,
      body,
    });
  }
  if (seen.length > count || (seen.length < count && body.data.length === 0)) {
    throw new Error('Page contents disagree with meta.count; collection is incomplete.');
  }
  if (seen.length < count) {
    state.page += 1;
    return state;
  }
  if (state.stage === 'employees') {
    state.stage = state.employeeIds.length ? 'requests' : 'done';
  } else {
    state.employeeResults.push({employee_id: employeeId, request_count: seen.length});
    state.employeeIndex += 1;
    if (state.employeeIndex === state.employeeIds.length) state.stage = 'done';
  }
  state.page = 1;
  state.expectedCount = null;
  state.currentRequestIds = [];
  delete state.requestUrl;
  return state;
}

function summarize(state) {
  if (state.stage !== 'done') throw new Error('Collection has not completed.');
  const statusCounts = {};
  const attributeFields = new Set();
  for (const row of state.requests) {
    const status = row.attributes?.request_status ?? 'missing';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    for (const field of Object.keys(row.attributes || {})) attributeFields.add(field);
  }
  return {
    collection_scope: 'All readable requests for the visible employee roster; organization coverage is unverified.',
    started_at: state.startedAt, finished_at: new Date().toISOString(),
    employee_count: state.employeeIds.length, request_count: state.requests.length,
    status_counts: statusCounts, observed_attribute_fields: [...attributeFields].sort(),
    coverage_warnings: [
      'Directory permissions may return only the caller; verify the employee count against the HR roster.',
      'Time Off visibility may differ from directory visibility; zero requests does not prove full access.',
      'Incomplete onboarding employees are excluded by the employee list.',
      'These reads are not an atomic snapshot; changes during collection can require a rerun.',
    ],
    employee_results: state.employeeResults,
    data: state.requests,
    raw_request_pages: state.rawRequestPages,
  };
}

function buildWorkflow() {
  const nodes = [
    {id:'manual', name:'Run read-only inspection', type:'n8n-nodes-base.manualTrigger', typeVersion:1, position:[0,0], parameters:{}},
    {id:'initialize', name:'Initialize collection', type:'n8n-nodes-base.code', typeVersion:2, position:[220,0], parameters:{mode:'runOnceForAllItems', jsCode:`${initialize.toString()}\nreturn [{ json: initialize() }];`}},
    {id:'pace', name:'Pace requests', type:'n8n-nodes-base.wait', typeVersion:1.1, position:[440,0], webhookId:'rise-inspection-wait', parameters:{resume:'timeInterval', amount:2, unit:'seconds'}},
    {id:'prepare', name:'Prepare next page', type:'n8n-nodes-base.code', typeVersion:2, position:[660,0], parameters:{mode:'runOnceForEachItem', jsCode:`${prepare.toString()}\nreturn { json: prepare($json) };`}},
    {id:'get', name:'GET Rise page - select credential', type:'n8n-nodes-base.httpRequest', typeVersion:4.2, position:[880,0], retryOnFail:false, parameters:{
      method:'GET', url:'={{ $json.requestUrl }}', authentication:'genericCredentialType', genericAuthType:'oAuth2Api',
      sendHeaders:true, headerParameters:{parameters:[{name:'Accept', value:'application/vnd.api+json'}]},
      options:{timeout:60000, redirect:{redirect:{followRedirects:false}}, response:{response:{fullResponse:true, responseFormat:'json'}}},
    }},
    {id:'process', name:'Validate and collect page', type:'n8n-nodes-base.code', typeVersion:2, position:[1100,0], parameters:{mode:'runOnceForEachItem', jsCode:`${processPage.toString()}\nreturn { json: processPage($('Prepare next page').item.json, $json) };`}},
    {id:'continue', name:'More pages or employees', type:'n8n-nodes-base.if', typeVersion:2.2, position:[1320,0], parameters:{conditions:{options:{caseSensitive:true, leftValue:'', typeValidation:'strict', version:2}, conditions:[{id:'not-done', leftValue:"={{ $json.stage !== 'done' }}", rightValue:'', operator:{type:'boolean', operation:'true', singleValue:true}}], combinator:'and'}, options:{}}},
    {id:'summary', name:'Time off sample output', type:'n8n-nodes-base.code', typeVersion:2, position:[1540,120], parameters:{mode:'runOnceForEachItem', jsCode:`${summarize.toString()}\nreturn { json: summarize($json) };`}},
  ];
  const edge = node => ({node, type:'main', index:0});
  return {
    name:'Rise HR - collect readable time off requests - inspection', nodes,
    connections:{
      'Run read-only inspection':{main:[[edge('Initialize collection')]]},
      'Initialize collection':{main:[[edge('Pace requests')]]},
      'Pace requests':{main:[[edge('Prepare next page')]]},
      'Prepare next page':{main:[[edge('GET Rise page - select credential')]]},
      'GET Rise page - select credential':{main:[[edge('Validate and collect page')]]},
      'Validate and collect page':{main:[[edge('More pages or employees')]]},
      'More pages or employees':{main:[[edge('Pace requests')],[edge('Time off sample output')]]},
    },
    active:false, settings:{executionOrder:'v1', timezone:'America/Toronto', saveManualExecutions:false, saveDataSuccessExecution:'none', saveDataErrorExecution:'none', saveExecutionProgress:false},
    pinData:{}, tags:[],
  };
}

module.exports = { initialize, prepare, processPage, summarize, buildWorkflow };
if (require.main === module) {
  const output = path.join(__dirname, '..', 'workflows', 'rise-time-off-inspection.json');
  fs.mkdirSync(path.dirname(output), {recursive:true});
  fs.writeFileSync(output, JSON.stringify(buildWorkflow(), null, 2) + '\n');
  process.stdout.write('Generated workflows/rise-time-off-inspection.json\n');
}
