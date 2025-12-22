'use strict';

const Homey = require('homey');

class LibraryUserDriver extends Homey.Driver {

  async onInit() {
    this.log('LibraryUserDriver initialized');
    this._registerFlowCards();
  }

  _registerFlowCards() {
    // Register user-specific trigger
    const userLoanExpiringTrigger = this.homey.flow.getDeviceTriggerCard('user_loan_expiring');
    userLoanExpiringTrigger.registerRunListener(async (args, state) => {
      return state.days_left <= args.days;
    });

    // Register user-specific condition
    const userHasExpiringCondition = this.homey.flow.getConditionCard('user_has_expiring_loans');
    userHasExpiringCondition.registerRunListener(async (args) => {
      const minDays = args.device.getCapabilityValue('user_days_remaining');
      return minDays !== null && minDays <= args.days;
    });

    // Register user-specific action
    const userExtendAction = this.homey.flow.getActionCard('user_extend_loans');
    userExtendAction.registerRunListener(async (args) => {
      return args.device.extendLoans(args.max_days);
    });

    this.log('User flow cards registered');
  }

  async onPair(session) {
    // Get the main account device to access stored data
    session.setHandler('list_devices', async () => {
      this.log('Listing user devices...');

      // Find the library-account device to get user data
      const accountDriver = this.homey.drivers.getDriver('library-account');
      const accountDevices = accountDriver.getDevices();

      if (accountDevices.length === 0) {
        this.log('No library account found - please add a Library Account first');
        return [];
      }

      const devices = [];

      for (const accountDevice of accountDevices) {
        const storedData = await accountDevice.getStoreValue('lastData');
        if (!storedData || !storedData.userDetails) continue;

        for (const [userId, user] of Object.entries(storedData.userDetails)) {
          const accountDetails = user.accountDetails || {};
          const userName = accountDetails.userName || accountDetails.name || 'Unknown';
          const libraryName = accountDetails.libraryName || 'Unknown';
          const barcode = accountDetails.barcode || '';

          devices.push({
            name: `${userName} (${libraryName})`,
            data: {
              id: `${userId}`,
              accountDeviceId: accountDevice.getData().id
            },
            settings: {
              barcode: barcode,
              library_name: libraryName
            },
            store: {
              userId: userId,
              userName: userName,
              libraryName: libraryName
            }
          });
        }
      }

      this.log(`Found ${devices.length} users`);
      return devices;
    });
  }

}

module.exports = LibraryUserDriver;
