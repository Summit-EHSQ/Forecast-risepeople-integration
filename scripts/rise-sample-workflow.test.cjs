const {test} = require('node:test');
const assert = require('node:assert/strict');
const {initialize, prepare, processPage, summarize, buildWorkflow} = require('./build-rise-sample-workflow.cjs');
const employee = id => ({id, type:'employees', attributes:{work_email:'unused@example.test'}});
const request = (id, employeeId, status='confirmed') => ({id, type:'time_off_requests', attributes:{employee_id:employeeId, request_status:status, start_date:'2026-10-26', future_daily_detail:[{minutes:240}]}});
const page = (data,count) => ({statusCode:200, headers:{'x-request-id':'test-correlation'}, body:{data, meta:{count}, extra_field:'preserved'}});

test('collects every page and employee, including zero requests and unknown fields', () => {
  let state = initialize(); state.pageSize = 1;
  state = processPage(prepare(state), page([employee('10')],2));
  assert.equal(state.page,2);
  state = processPage(prepare(state), page([employee('20')],2));
  assert.equal(state.stage,'requests');
  assert.match(prepare(state).requestUrl,/employee_id=10$/);
  state = processPage(prepare(state), page([request('101','10')],2));
  state = processPage(prepare(state), page([request('102','10','rejected')],2));
  state = processPage(prepare(state), page([],0));
  const result = summarize(state);
  assert.equal(result.employee_count,2); assert.equal(result.request_count,2);
  assert.deepEqual(result.status_counts,{confirmed:1,rejected:1});
  assert.deepEqual(result.data[0].attributes.future_daily_detail,[{minutes:240}]);
  assert.equal(result.raw_request_pages[0].body.extra_field,'preserved');
  assert.equal(result.employee_results[1].request_count,0);
  assert.equal(result.raw_request_pages.length,3);
});

test('fails on drifting totals, duplicated IDs, missing metadata, and incomplete pages', () => {
  const state = processPage(prepare(initialize()),page([employee('10')],2));
  assert.throws(()=>processPage(prepare(state),page([employee('20')],3)),/total changed/);
  assert.throws(()=>processPage(prepare(state),page([employee('10')],2)),/Repeated/);
  assert.throws(()=>processPage(prepare(state),page([],2)),/incomplete/);
  assert.throws(()=>processPage(prepare(state),{statusCode:200,body:{data:[]}}),/meta.count/);
  assert.throws(()=>processPage(prepare(state),{statusCode:429,body:{data:[]}}),/incomplete/);
});

test('rejects requests returned for the wrong employee', () => {
  const state = processPage(prepare(initialize()),page([employee('10')],1));
  assert.throws(()=>processPage(prepare(state),page([request('101','20')],1)),/does not match/);
});

test('empty directory completes with visible coverage warning rather than claiming organization completeness', () => {
  const result = summarize(processPage(prepare(initialize()),page([],0)));
  assert.equal(result.employee_count,0);
  assert.match(result.collection_scope,/unverified/);
  assert.ok(result.coverage_warnings.length);
});

test('export has GET-only API node, no credentials or scheduling, and compilable embedded code', () => {
  const flow = buildWorkflow();
  assert.equal(flow.active,false);
  assert.equal(flow.nodes.filter(n=>n.type.includes('httpRequest')).length,1);
  for (const node of flow.nodes) {
    assert.equal(node.credentials,undefined);
    if (node.type.includes('httpRequest')) {
      assert.equal(node.parameters.method,'GET'); assert.equal(node.retryOnFail,false);
    }
    if (node.parameters.jsCode) new Function('$json','$',node.parameters.jsCode);
    for (const outputs of flow.connections[node.name]?.main || []) {
      for (const output of outputs) assert.ok(flow.nodes.some(n=>n.name===output.node));
    }
  }
  const url = prepare(initialize()).requestUrl;
  assert.equal(new URL(url).searchParams.get('page[number]'),'1');
  assert.equal(new URL(url).searchParams.get('page[size]'),'100');
  assert.equal(new URL(url).searchParams.has('status'),false);
});
