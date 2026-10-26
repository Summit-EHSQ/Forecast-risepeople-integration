# Collect Rise time off requests in n8n

Use [the inspection workflow](../workflows/rise-time-off-inspection.json) to collect real Rise responses before implementing the synchronization. It reads the visible employee roster, retrieves every page of time-off requests for each employee, and produces one output bundle with the original request resources and raw time-off response pages. It does not filter by status or date, so approved, pending, and other readable historical requests are included.

The workflow is prepared but has not been imported into your n8n instance or executed against Rise. Rise credentials still need to be obtained. Offline checks cover the transformation and collection logic, not live authentication or n8n runtime compatibility.

## Obtain credentials

Ask your Rise administrator to provision an OAuth application suitable for a server integration, with a service user permitted to read the intended employee directory and time-off requests. Request these read scopes:

- `employees:read`
- `time_off:read`

Obtain the application's client ID and client secret through your normal secure process. Do not put them in this repository or chat. Directory/profile permissions and Time Off permissions must cover the intended staff; OAuth scopes alone do not establish that coverage. [Rise People API](https://developer.risepeople.com/reference/people/), [Time Off API](https://developer.risepeople.com/reference/time-off/).

## Configure the n8n credential

Create a generic OAuth2 API credential in n8n with the following settings, or use an existing credential with equivalent configuration:

| Setting | Value |
| --- | --- |
| Grant type | Client Credentials |
| Access token URL | `https://api.risepeople.com/oauth/token` |
| Client ID | The value provided by Rise |
| Client secret | The secret provided by Rise |
| Scope | `employees:read time_off:read` |
| Authentication | Body |

Keep certificate validation enabled. n8n documents support for client credentials with authentication values sent in the request body. Credential field labels can vary by version. [n8n HTTP Request credentials](https://docs.n8n.io/integrations/builtin/credentials/httprequest/).

The OAuth exchange obtains a token; the workflow's resource requests are GET-only. No request submission, approval, modification, cancellation, or Forecast call is included.

## Import and run

1. Import `workflows/rise-time-off-inspection.json` into your existing n8n environment using its workflow import action.
2. Open **GET Rise page - select credential** and select the OAuth2 credential above. The export contains no credential IDs or secrets.
3. Review the imported nodes and settings against your deployed n8n version. In the HTTP node, retain JSON response format and **Include Response Headers and Status**; the validation step expects `body`, `headers`, and `statusCode`.
4. Run one manual execution using **Run read-only inspection**. Avoid concurrent executions or other inspection runs against the same Rise account.
5. Inspect **Time off sample output** when the workflow finishes. Copy or download its JSON output into the locally ignored `samples/` folder if you need a file, such as `samples/rise-time-off-requests.json`. Do not pin real HR responses to the workflow or include them in an exported workflow.
6. Compare `employee_count` with the expected HR roster before treating the results as organization-wide. Verify access for at least one employee outside the service user's immediate team and one known approved request.

The HTTP node calls:

```http
GET https://api.risepeople.com/v1/employees?page%5Bnumber%5D=1&page%5Bsize%5D=100
Authorization: Bearer <managed by n8n>
Accept: application/vnd.api+json
```

Then, for every returned employee resource ID:

```http
GET https://api.risepeople.com/v1/time_off_requests?employee_id=<employee-id>&page%5Bnumber%5D=1&page%5Bsize%5D=100
Authorization: Bearer <managed by n8n>
Accept: application/vnd.api+json
```

Page numbers increase until collected unique resources match `meta.count`. A two-second Wait node precedes each resource GET. This is an inspection pacing assumption rather than a vendor guarantee; token exchanges and other workflows are outside this workflow's pacing. The workflow stops on HTTP errors, including throttling, rather than applying automatic retries. Honor any `Retry-After` response before a new run.

## Read the results

| Output field | Purpose |
| --- | --- |
| `employee_count` | Number of employees visible to the directory credential |
| `request_count` | Number of unique time-off requests collected |
| `status_counts` | Counts by the actual returned request status |
| `observed_attribute_fields` | Attribute names actually present across the request responses |
| `employee_results` | Per-employee request counts, including employees with zero returned requests |
| `data` | Original time-off resources, with unknown fields preserved |
| `raw_request_pages` | Complete time-off response bodies, source employee/page, retrieval time, and response correlation ID |
| `coverage_warnings` | Reasons the visible roster and requests may not represent the entire organization |

For the daily-quantity question, inspect a confirmed request in `data` and its corresponding raw page. Check for nested daily quantities, policy/enrollment identifiers, relationships, and any top-level `included` resources. Their presence is not assumed, and the workflow does not calculate or fabricate missing quantities. If this endpoint returns only status and date boundaries, the collected sample establishes that limitation and we can assess a different supported read or report next.

Employee responses are used to retain resource IDs only; unrelated employee attributes are not included in the final output. The full request responses can still contain HR data, so use the normal access and retention controls. The export requests that manual/success/error execution payloads not be saved; verify those settings after import. Live editor data and platform operational logs may still be available under your instance's controls.

## Completeness and failures

The employee list excludes unfinished onboarding staff, and permissions may return only the caller or hide particular requests. A zero count is not proof that nobody has requested leave. The workflow therefore labels completion as collection for the visible roster, with organization coverage unverified.

If pages repeat IDs, totals change, required metadata is absent, or a request's employee ID does not match the queried employee, validation stops rather than presenting a partial export as complete. Since collection takes several reads, it is not a transactionally consistent snapshot. On a failed run, inspect the failing node and rerun the complete read after resolving the cause; no live HR or Forecast records need reversal.

This sample collector holds the accumulated output in the workflow execution and is intended for an initial inspection. For a large history, move to the design's durable database staging rather than repeatedly growing the in-memory bundle. It is not the production synchronization, shared rate limiter, or recovery worker.

## Maintain the export

The credential-free export is generated from `scripts/build-rise-sample-workflow.cjs`. With Node.js available, run:

```powershell
node --test scripts/rise-sample-workflow.test.cjs
node scripts/build-rise-sample-workflow.cjs
```

Regeneration preserves the code steps tested offline. Re-import and validate against your n8n version after changing the workflow.
