'use strict';

const Homey = require('homey');

class LibraryUserDevice extends Homey.Device {

  async onInit() {
    this.log('LibraryUserDevice initialized');

    this._userId = await this.getStoreValue('userId');
    this._userName = await this.getStoreValue('userName');
    this._previousDaysRemaining = null;
    this._previousLoans = new Map();

    // Listen for updates from the main account device
    this._setupUpdateListener();

    // Initial data load
    await this._refreshFromAccountDevice();
  }

  _setupUpdateListener() {
    // Poll periodically to sync with account device
    // The account device does the actual API calls
    this._pollInterval = this.homey.setInterval(async () => {
      await this._refreshFromAccountDevice();
    }, 60 * 1000); // Check every minute for updates from account device
  }

  async _refreshFromAccountDevice() {
    try {
      // Find the parent account device
      const accountDriver = this.homey.drivers.getDriver('library-account');
      const accountDevices = accountDriver.getDevices();
      const accountDeviceId = this.getData().accountDeviceId;

      const accountDevice = accountDevices.find(d => d.getData().id === accountDeviceId);
      if (!accountDevice) {
        this.log('Parent account device not found');
        await this.setUnavailable('Parent account not found');
        return;
      }

      const storedData = await accountDevice.getStoreValue('lastData');
      if (!storedData) {
        this.log('No data from account device');
        return;
      }

      await this._processUserData(storedData);
      await this.setAvailable();
    } catch (error) {
      this.error('Failed to refresh user data:', error);
    }
  }

  async _processUserData(data) {
    const { userDetails, loans } = data;
    const userId = this._userId;
    const userName = this._userName;

    const user = userDetails?.[userId];
    if (!user) {
      this.log(`User ${userId} not found in data`);
      return;
    }

    const warningThreshold = 7; // Could make this a setting

    // Filter loans for this user
    const userLoans = (loans || []).filter(loan =>
      loan.accountName === userName || loan.accountId === userId
    );

    // Calculate user-specific values
    let minDaysRemaining = null;
    let totalLoans = 0;
    let expiringSoon = 0;
    let someNotExtendable = false;
    const currentLoans = new Map();

    for (const loan of userLoans) {
      totalLoans++;

      const daysLeft = this._calculateDaysRemaining(loan.dueDate);

      if (minDaysRemaining === null || daysLeft < minDaysRemaining) {
        minDaysRemaining = daysLeft;
      }

      if (daysLeft <= warningThreshold) {
        expiringSoon++;
      }

      if (loan.isRenewable === false) {
        someNotExtendable = true;
      }

      const loanKey = loan.title || '';
      currentLoans.set(loanKey, {
        title: loan.title || 'Unknown',
        author: loan.author || '',
        daysLeft,
        isExtendable: loan.isRenewable !== false,
        dueDate: loan.dueDate
      });
    }

    // Enrich with detailed loan data
    if (user.loanDetails) {
      for (const [key, loanDetail] of Object.entries(user.loanDetails)) {
        if (!loanDetail.isExtendable) {
          someNotExtendable = true;
        }

        if (currentLoans.has(loanDetail.title)) {
          const existingLoan = currentLoans.get(loanDetail.title);
          existingLoan.daysLeft = loanDetail.daysRemaining;
          existingLoan.extendLoanId = loanDetail.extendLoanId;
          existingLoan.isExtendable = loanDetail.isExtendable;

          if (loanDetail.daysRemaining < minDaysRemaining) {
            minDaysRemaining = loanDetail.daysRemaining;
          }
        }
      }
    }

    // Get reservation count
    const reservations = user.reservations?.count || 0;

    // Update capabilities
    await this.setCapabilityValue('user_days_remaining', minDaysRemaining).catch(this.error);
    await this.setCapabilityValue('user_loan_count', totalLoans).catch(this.error);
    await this.setCapabilityValue('user_reservation_count', reservations).catch(this.error);
    await this.setCapabilityValue('user_loans_expiring_soon', expiringSoon).catch(this.error);
    await this.setCapabilityValue('user_some_not_extendable', someNotExtendable).catch(this.error);

    // Check for triggers
    await this._checkTriggers(currentLoans, minDaysRemaining, warningThreshold);

    // Store for next comparison
    this._previousDaysRemaining = minDaysRemaining;
    this._previousLoans = currentLoans;

    // Store loan details for extend action
    await this.setStoreValue('userLoanDetails', user.loanDetails || {});
    await this.setStoreValue('loansUrl', user.loans?.url || '');

    this.log(`User ${userName}: ${totalLoans} loans, min days: ${minDaysRemaining}`);
  }

  _buildLoansSummary(currentLoans) {
    const loans = Array.from(currentLoans.values());
    loans.sort((a, b) => a.daysLeft - b.daysLeft);

    const lines = loans.map(loan => {
      const daysStr = loan.daysLeft < 0
        ? `${Math.abs(loan.daysLeft)}d overdue!`
        : `${loan.daysLeft}d`;
      const extendable = loan.isExtendable ? '' : ' [!]';
      return `${loan.title} (${daysStr})${extendable}`;
    });

    let summary = lines.join('\n');
    if (summary.length > 500) {
      summary = summary.substring(0, 497) + '...';
    }

    return summary || 'No loans';
  }

  async _checkTriggers(currentLoans, minDaysRemaining, warningThreshold) {
    // Trigger for each loan crossing threshold
    for (const [loanKey, loan] of currentLoans) {
      const previousLoan = this._previousLoans.get(loanKey);

      if (!previousLoan || (previousLoan.daysLeft > warningThreshold && loan.daysLeft <= warningThreshold)) {
        if (loan.daysLeft <= warningThreshold && loan.daysLeft >= 0) {
          this.log(`User loan expiring: ${loan.title} (${loan.daysLeft} days)`);

          const trigger = this.homey.flow.getDeviceTriggerCard('user_loan_expiring');
          await trigger.trigger(this, {
            book_title: loan.title,
            days_left: loan.daysLeft
          }, {
            days_left: loan.daysLeft
          }).catch(this.error);
        }
      }
    }
  }

  _calculateDaysRemaining(dueDateStr) {
    if (!dueDateStr) return 0;

    try {
      const parts = dueDateStr.split('/');
      let dueDate;

      if (parts.length === 3) {
        const [day, month, year] = parts.map(Number);
        dueDate = new Date(year, month - 1, day);
      } else {
        dueDate = new Date(dueDateStr);
      }

      if (isNaN(dueDate.getTime())) return 0;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      dueDate.setHours(0, 0, 0, 0);

      const diffMs = dueDate - today;
      return Math.floor(diffMs / (1000 * 60 * 60 * 24));
    } catch {
      return 0;
    }
  }

  async extendLoans(maxDays) {
    this.log(`Extending loans for user with ${maxDays} or fewer days remaining...`);

    try {
      const loanDetails = await this.getStoreValue('userLoanDetails') || {};
      const loansUrl = await this.getStoreValue('loansUrl');

      if (!loansUrl) {
        this.log('No loans URL available');
        return false;
      }

      const baseUrl = loansUrl.replace(/\/loans$/, '');
      const loansToExtend = [];

      for (const [key, loan] of Object.entries(loanDetails)) {
        if (loan.isExtendable && loan.extendLoanId && loan.daysRemaining <= maxDays) {
          loansToExtend.push(loan.extendLoanId);
        }
      }

      if (loansToExtend.length === 0) {
        this.log('No loans to extend');
        return false;
      }

      // Get the API from the parent account device
      const accountDriver = this.homey.drivers.getDriver('library-account');
      const accountDevices = accountDriver.getDevices();
      const accountDeviceId = this.getData().accountDeviceId;
      const accountDevice = accountDevices.find(d => d.getData().id === accountDeviceId);

      if (!accountDevice) {
        this.log('Parent account device not found');
        return false;
      }

      const count = await accountDevice.api.extendLoans(baseUrl, loansToExtend);
      this.log(`Extended ${count} loans`);

      // Trigger refresh on parent
      if (count > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        await accountDevice.refreshData();
      }

      return count > 0;
    } catch (error) {
      this.error('Failed to extend loans:', error);
      return false;
    }
  }

  async onDeleted() {
    this.log('User device deleted');
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
    }
  }

}

module.exports = LibraryUserDevice;
