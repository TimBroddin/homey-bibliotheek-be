'use strict';

const Homey = require('homey');
const BibliotheekAPI = require('../../lib/BibliotheekAPI');

class LibraryAccountDriver extends Homey.Driver {

  async onInit() {
    this.log('LibraryAccountDriver initialized');
    this._registerFlowCards();
  }

  _registerFlowCards() {
    // Register trigger card listeners
    this._registerTriggerCards();

    // Register condition card listeners
    this._registerConditionCards();

    // Register action card listeners
    this._registerActionCards();

    this.log('Flow cards registered');
  }

  _registerTriggerCards() {
    // loan_expiring trigger - registered per device, uses runListener for filtering
    const loanExpiringTrigger = this.homey.flow.getDeviceTriggerCard('loan_expiring');
    loanExpiringTrigger.registerRunListener(async (args, state) => {
      // Only trigger if the loan's days match the threshold
      return state.days_left <= args.days;
    });

    // loan_expired trigger - no filtering needed
    // const loanExpiredTrigger = this.homey.flow.getDeviceTriggerCard('loan_expired');

    // days_changed trigger - no filtering needed
    // const daysChangedTrigger = this.homey.flow.getDeviceTriggerCard('days_changed');
  }

  _registerConditionCards() {
    // has_expiring_loans condition
    const hasExpiringCondition = this.homey.flow.getConditionCard('has_expiring_loans');
    hasExpiringCondition.registerRunListener(async (args) => {
      const minDays = args.device.getCapabilityValue('days_remaining');
      return minDays !== null && minDays <= args.days;
    });

    // can_extend_all condition
    const canExtendAllCondition = this.homey.flow.getConditionCard('can_extend_all');
    canExtendAllCondition.registerRunListener(async (args) => {
      const someNotExtendable = args.device.getCapabilityValue('some_not_extendable');
      return !someNotExtendable;
    });

    // has_overdue_loans condition
    const hasOverdueCondition = this.homey.flow.getConditionCard('has_overdue_loans');
    hasOverdueCondition.registerRunListener(async (args) => {
      const minDays = args.device.getCapabilityValue('days_remaining');
      return minDays !== null && minDays < 0;
    });
  }

  _registerActionCards() {
    // extend_all_loans action
    const extendAllAction = this.homey.flow.getActionCard('extend_all_loans');
    extendAllAction.registerRunListener(async (args) => {
      return args.device.extendAllLoans(args.max_days);
    });

    // refresh_data action
    const refreshAction = this.homey.flow.getActionCard('refresh_data');
    refreshAction.registerRunListener(async (args) => {
      return args.device.refreshData();
    });
  }

  async onPair(session) {
    let username = '';
    let password = '';
    let api = null;
    let fetchedData = null;

    // Handle login credentials
    session.setHandler('login', async (data) => {
      username = data.username;
      password = data.password;

      this.log(`Attempting login for: ${username}`);

      try {
        api = new BibliotheekAPI(this.homey);
        const success = await api.login(username, password);

        if (success) {
          this.log('Login successful');
          // Store api for list_devices to use
          fetchedData = { loginSuccess: true };
        }

        return success;
      } catch (error) {
        this.error('Login failed:', error);
        return false;
      }
    });

    // List devices (one device per account)
    session.setHandler('list_devices', async () => {
      this.log('Listing devices...');

      if (!fetchedData || !fetchedData.loginSuccess) {
        this.error('No successful login');
        return [];
      }

      try {
        // Create one device that aggregates all accounts
        const devices = [{
          name: `Bibliotheek.be (${username})`,
          data: {
            id: username // Use email as unique identifier
          },
          settings: {
            username,
            password,
            poll_interval: 30,
            warning_threshold: 7
          }
        }];

        this.log(`Returning ${devices.length} device(s)`);
        return devices;
      } catch (error) {
        this.error('Failed to list devices:', error);
        return [];
      }
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async (data) => {
      this.log(`Attempting repair login for device: ${device.getName()}`);

      try {
        const api = new BibliotheekAPI(this.homey);
        const success = await api.login(data.username, data.password);

        if (success) {
          // Update device settings with new credentials
          await device.setSettings({
            username: data.username,
            password: data.password
          });

          // Trigger a data refresh
          await device.refreshData();

          this.log('Repair successful');
        }

        return success;
      } catch (error) {
        this.error('Repair login failed:', error);
        return false;
      }
    });
  }

}

module.exports = LibraryAccountDriver;
