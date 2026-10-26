const assert = require("node:assert/strict");
const { afterEach, beforeEach, describe, it, mock } = require("node:test");
const axios = require("axios");
const { ShipStation } = require("../dist");

const credentials = {
	v1: { apiKey: "v1-test-key", apiSecret: "v1-test-secret" },
	v2: { apiKey: "v2-test-key" },
};
const retryConfig = {
	retries: 2,
	retryCondition: (error) => error.code === "ECONNABORTED",
	retryDelay: () => 0,
};
const originalAdapter = axios.defaults.adapter;

const respond = (data) => (config) =>
	Promise.resolve({
		config,
		data,
		headers: {},
		status: 200,
		statusText: "OK",
	});

const rejectTimeout = (config) =>
	Promise.reject(new axios.AxiosError("Timed out", "ECONNABORTED", config));

beforeEach(() => {
	// A broken transport must fail locally instead of contacting ShipStation.
	axios.defaults.adapter = rejectTimeout;
});

afterEach(() => {
	axios.defaults.adapter = originalAdapter;
	axios.interceptors.request.clear();
	axios.interceptors.response.clear();
});

describe("SDK HTTP transport", () => {
	for (const version of ["v1", "v2"]) {
		it(`honors request configuration for ${version}`, async () => {
			const data = { result: "provider response" };
			const adapter = mock.fn(respond(data));
			const timeout = 5000;
			const client = new ShipStation({
				credentials,
				requestConfig: { adapter, timeout },
			});

			const result = await client[version].request({
				method: "GET",
				url: "tags",
			});

			assert.deepEqual(result, data);
			assert.equal(adapter.mock.callCount(), 1);
			assert.equal(adapter.mock.calls[0].arguments[0].timeout, timeout);
		});
	}

	it("retries POST timeouts using the configured policy", async () => {
		const data = { rates: [] };
		const adapter = mock.fn(respond(data));
		adapter.mock.mockImplementationOnce(rejectTimeout, 0);
		adapter.mock.mockImplementationOnce(rejectTimeout, 1);
		const client = new ShipStation({
			credentials,
			requestConfig: { adapter },
			retryConfig,
		});

		const result = await client.v2.request({ method: "POST", url: "rates" });

		assert.deepEqual(result, data);
		assert.equal(adapter.mock.callCount(), 3);
	});

	it("keeps retry settings separate between SDK clients", async () => {
		new ShipStation({ credentials, retryConfig });
		const adapter = mock.fn(rejectTimeout);
		const client = new ShipStation({
			credentials,
			requestConfig: { adapter },
		});

		await assert.rejects(client.v2.request({ method: "POST", url: "rates" }), {
			code: "ECONNABORTED",
		});
		assert.equal(adapter.mock.callCount(), 1);
	});

	it("leaves unrelated Axios requests unretried after constructing SDK clients", async () => {
		const adapter = mock.fn(rejectTimeout);
		axios.defaults.adapter = adapter;
		new ShipStation({ credentials, retryConfig });
		new ShipStation({ credentials, retryConfig });
		new ShipStation({ credentials, retryConfig });

		await assert.rejects(
			axios.get("https://other-service.example.com/health"),
			{
				code: "ECONNABORTED",
			},
		);
		assert.equal(adapter.mock.callCount(), 1);
	});
});
