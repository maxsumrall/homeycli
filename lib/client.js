const { AthomCloudAPI } = require('homey-api');
const fuzzy = require('./fuzzy');
const { cliError } = require('./errors');
const { resolveByIdOrName } = require('./resolve');

/**
 * Homey API client wrapper
 */
class HomeyClient {
  constructor(token) {
    this.token = token;
    this.api = null;
    this.homeyApi = null;
    this.homey = null;
  }

  /**
   * Connect to Homey Cloud API and authenticate
   */
  async connect() {
    if (!this.token) {
      throw cliError(
        'NO_TOKEN',
        'no Homey token found (set HOMEY_TOKEN or write ~/.homey/config.json)',
        { help: 'Get a token from https://tools.developer.homey.app/api/clients' }
      );
    }

    // Create Cloud API instance
    this.api = new AthomCloudAPI({ token: this.token });

    // Get authenticated user and their first Homey
    const user = await this.api.getAuthenticatedUser();
    this.homey = await user.getFirstHomey();

    // Create session
    this.homeyApi = await this.homey.authenticate();

    return this.homeyApi;
  }

  async _ensureConnected() {
    if (!this.homeyApi) await this.connect();
  }

  _pickDevice(id, device, options = {}) {
    const capabilitiesObj = device.capabilitiesObj || {};
    const values = Object.fromEntries(
      Object.entries(capabilitiesObj).map(([capabilityId, cap]) => [capabilityId, cap?.value])
    );

    const picked = {
      id,
      name: device.name,
      // Both are useful: zoneId for lookups, zoneName for display
      zoneId: device.zone || null,
      zoneName: device.zoneName || null,
      zone: device.zoneName || device.zone || null,
      class: device.class,
      driverId: device.driverId || null,
      uri: device.uri || null,
      capabilities: device.capabilities || [],
      capabilitiesObj,
      values,
      available: device.available,
      ready: device.ready,
    };

    if (options.raw) {
      picked.raw = device;
    }

    return picked;
  }

  _pickFlow(id, flow, options = {}) {
    const picked = {
      id,
      name: flow.name,
      enabled: flow.enabled,
      folder: flow.folder || null,
    };

    if (options.raw) {
      picked.raw = flow;
    }

    return picked;
  }

  /**
   * Get all devices
   * @returns {Promise<Array>} Array of devices
   */
  async getDevices(options = {}) {
    await this._ensureConnected();

    const devicesObj = await this.homeyApi.devices.getDevices();
    return Object.entries(devicesObj).map(([id, device]) => this._pickDevice(id, device, options));
  }

  /**
   * Get device by ID or name (fuzzy)
   * @param {string} nameOrId Device name or ID
   * @returns {Promise<object>} Device object
   */
  async getDevice(nameOrId, options = {}) {
    await this._ensureConnected();

    const devicesObj = await this.homeyApi.devices.getDevices();

    const resolved = resolveByIdOrName(nameOrId, devicesObj, {
      typeLabel: 'device',
      threshold: options.threshold,
      getName: (d) => d.name,
    });

    return this._pickDevice(resolved.id, resolved.value, options);
  }

  /**
   * Set device capability value
   * @param {string} deviceId Device ID
   * @param {string} capability Capability ID
   * @param {any} value Value to set
   */
  async setCapability(deviceId, capability, value) {
    await this._ensureConnected();

    const device = await this.homeyApi.devices.getDevice({ id: deviceId });
    await device.setCapabilityValue({
      capabilityId: capability,
      value,
    });
  }

  /**
   * Get device capability value
   * @param {string} deviceId Device ID
   * @param {string} capability Capability ID
   * @returns {Promise<any>} Capability value
   */
  async getCapability(deviceId, capability) {
    await this._ensureConnected();

    const device = await this.homeyApi.devices.getDevice({ id: deviceId });
    return device.capabilitiesObj[capability]?.value;
  }

  /**
   * Get all flows
   * @returns {Promise<Array>} Array of flows
   */
  async getFlows(options = {}) {
    await this._ensureConnected();

    const flowsObj = await this.homeyApi.flow.getFlows();
    return Object.entries(flowsObj).map(([id, flow]) => this._pickFlow(id, flow, options));
  }

  /**
   * Search devices by query (returns multiple matches)
   */
  async searchDevices(query, options = {}) {
    await this._ensureConnected();

    const devicesObj = await this.homeyApi.devices.getDevices();
    const entries = Object.entries(devicesObj).map(([id, device]) => ({
      id,
      name: device.name,
      device,
    }));

    const q = String(query || '').trim();
    if (!q) {
      return Object.entries(devicesObj).map(([id, device]) => this._pickDevice(id, device, options));
    }

    const matches = fuzzy.fuzzySearch(q, entries, options.limit ?? 50);
    return matches.map(m => this._pickDevice(m.id, m.device, options));
  }

  /**
   * Search flows by query (returns multiple matches)
   */
  async searchFlows(query, options = {}) {
    await this._ensureConnected();

    const flowsObj = await this.homeyApi.flow.getFlows();
    const entries = Object.entries(flowsObj).map(([id, flow]) => ({
      id,
      name: flow.name,
      flow,
    }));

    const q = String(query || '').trim();
    if (!q) {
      return Object.entries(flowsObj).map(([id, flow]) => this._pickFlow(id, flow, options));
    }

    const matches = fuzzy.fuzzySearch(q, entries, options.limit ?? 50);
    return matches.map(m => this._pickFlow(m.id, m.flow, options));
  }

  /**
   * Trigger a flow by ID or name
   * @param {string} nameOrId Flow name or ID
   */
  async triggerFlow(nameOrId, options = {}) {
    await this._ensureConnected();

    const flowsObj = await this.homeyApi.flow.getFlows();

    const resolved = resolveByIdOrName(nameOrId, flowsObj, {
      typeLabel: 'flow',
      threshold: options.threshold,
      getName: (f) => f.name,
    });

    await resolved.value.trigger();
    return this._pickFlow(resolved.id, resolved.value, options);
  }

  /**
   * Get all zones
   * @returns {Promise<Array>} Array of zones
   */
  async getZones(options = {}) {
    await this._ensureConnected();

    const zonesObj = await this.homeyApi.zones.getZones();
    return Object.entries(zonesObj).map(([id, zone]) => {
      const picked = {
        id,
        name: zone.name,
        parent: zone.parent,
        icon: zone.icon,
      };
      if (options.raw) picked.raw = zone;
      return picked;
    });
  }

  /**
   * Get Homey status/info
   * @returns {Promise<object>} Homey info
   */
  async getStatus() {
    await this._ensureConnected();

    const system = await this.homeyApi.system.getInfo();

    return {
      name: this.homey.name,
      platform: system.platform,
      platformVersion: system.platformVersion,
      hostname: system.hostname,
      cloudId: this.homey.id,
      connected: true,
    };
  }
}

module.exports = HomeyClient;
