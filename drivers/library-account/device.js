'use strict';

const Homey = require('homey');
const BibliotheekAPI = require('../../lib/BibliotheekAPI');

class LibraryAccountDevice extends Homey.Device {

  async onInit() {
    this.log('LibraryAccountDevice initialized');

    this.api = new BibliotheekAPI(this.homey);
    this._previousDaysRemaining = null;
    this._previousLoans = new Map(); // Track loan states for trigger detection
    this._pollInterval = null;

    // Load initial data from store if available
    const storedData = await this.getStoreValue('lastData');
    if (storedData) {
      await this._processData(storedData, false); // Don't trigger on initial load
    }

    // Set up polling
    this._setupPolling();

    // Do an initial refresh
    this.refreshData().catch(err => {
      this.error('Initial data refresh failed:', err);
    });
  }

  _setupPolling() {
    // Clear existing interval if any
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
    }

    const intervalMinutes = this.getSetting('poll_interval') || 30;
    const intervalMs = intervalMinutes * 60 * 1000;

    this._pollInterval = this.homey.setInterval(async () => {
      this.log('Polling for data...');
      await this.refreshData();
    }, intervalMs);

    this.log(`Polling set up for every ${intervalMinutes} minutes`);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);

    if (changedKeys.includes('poll_interval')) {
      this._setupPolling();
    }
  }

  /**
   * Refresh all data from bibliotheek.be
   */
  async refreshData() {
    this.log('Refreshing data...');

    try {
      const settings = this.getSettings();
      const data = await this.api.refreshAllData(settings.username, settings.password);

      // Store the data
      await this.setStoreValue('lastData', data);

      // Process and update capabilities
      await this._processData(data, true);

      // Mark device as available
      await this.setAvailable();

      this.log('Data refresh complete');
      return true;
    } catch (error) {
      this.error('Failed to refresh data:', error);
      await this.setUnavailable(error.message);
      return false;
    }
  }

  /**
   * Process fetched data and update capabilities
   * @param {Object} data - Data from API
   * @param {boolean} triggerFlows - Whether to trigger Flow cards
   */
  async _processData(data, triggerFlows = true) {
    const { userDetails, loans } = data;
    const warningThreshold = this.getSetting('warning_threshold') || 7;

    // Calculate aggregated values
    let minDaysRemaining = null;
    let totalLoans = 0;
    let totalReservations = 0;
    let expiringSoon = 0;
    let someNotExtendable = false;

    // Build a map of all loans with their details
    const currentLoans = new Map();

    // Process loans from the overview
    for (const loan of loans || []) {
      totalLoans++;

      // Calculate days remaining
      const daysLeft = this._calculateDaysRemaining(loan.dueDate);

      // Track minimum
      if (minDaysRemaining === null || daysLeft < minDaysRemaining) {
        minDaysRemaining = daysLeft;
      }

      // Count expiring soon
      if (daysLeft <= warningThreshold) {
        expiringSoon++;
      }

      // Check extendability
      if (loan.isRenewable === false) {
        someNotExtendable = true;
      }

      // Store loan info for trigger detection
      const loanKey = `${loan.title || ''}|${loan.accountName || ''}`;
      currentLoans.set(loanKey, {
        title: loan.title || 'Unknown',
        author: loan.author || '',
        daysLeft,
        libraryName: loan.location?.libraryName || this._extractLibraryFromUrl(loan.location?.libraryUrl) || 'Unknown',
        userName: loan.accountName || 'Unknown',
        isExtendable: loan.isRenewable !== false,
        dueDate: loan.dueDate,
        extendLoanId: loan.extendLoanId || null
      });
    }

    // Also check detailed loan info from each user
    for (const [userId, user] of Object.entries(userDetails || {})) {
      const reservationCount = user.reservations?.count || 0;
      totalReservations += reservationCount;

      // Process detailed loans if available (has extend_loan_id)
      if (user.loanDetails) {
        for (const [key, loanDetail] of Object.entries(user.loanDetails)) {
          if (!loanDetail.isExtendable) {
            someNotExtendable = true;
          }

          // Update days remaining from detailed info (more accurate)
          if (loanDetail.daysRemaining !== undefined) {
            const detailKey = `${loanDetail.title}|${user.accountDetails?.userName || ''}`;
            if (currentLoans.has(detailKey)) {
              const existingLoan = currentLoans.get(detailKey);
              existingLoan.daysLeft = loanDetail.daysRemaining;
              existingLoan.extendLoanId = loanDetail.extendLoanId;
              existingLoan.isExtendable = loanDetail.isExtendable;

              // Recalculate minimum
              if (loanDetail.daysRemaining < minDaysRemaining) {
                minDaysRemaining = loanDetail.daysRemaining;
              }
            }
          }
        }
      }
    }

    // Recalculate expiring soon with accurate data
    expiringSoon = 0;
    for (const loan of currentLoans.values()) {
      if (loan.daysLeft <= warningThreshold) {
        expiringSoon++;
      }
    }

    // Update capabilities
    await this.setCapabilityValue('days_remaining', minDaysRemaining).catch(this.error);
    await this.setCapabilityValue('loan_count', totalLoans).catch(this.error);
    await this.setCapabilityValue('reservation_count', totalReservations).catch(this.error);
    await this.setCapabilityValue('loans_expiring_soon', expiringSoon).catch(this.error);
    await this.setCapabilityValue('some_not_extendable', someNotExtendable).catch(this.error);

    // Trigger flows if enabled
    if (triggerFlows) {
      await this._checkAndTriggerFlows(currentLoans, minDaysRemaining, totalLoans, warningThreshold);
    }

    // Update previous state
    this._previousDaysRemaining = minDaysRemaining;
    this._previousLoans = currentLoans;

    this.log(`Processed: ${totalLoans} loans, ${totalReservations} reservations, min days: ${minDaysRemaining}`);
  }

  /**
   * Check loan states and trigger appropriate flows
   */
  async _checkAndTriggerFlows(currentLoans, minDaysRemaining, totalLoans, warningThreshold) {
    // Trigger: days_changed
    if (this._previousDaysRemaining !== null && this._previousDaysRemaining !== minDaysRemaining) {
      this.log(`Days changed from ${this._previousDaysRemaining} to ${minDaysRemaining}`);

      const daysChangedTrigger = this.homey.flow.getDeviceTriggerCard('days_changed');
      await daysChangedTrigger.trigger(this, {
        days: minDaysRemaining,
        loan_count: totalLoans
      }).catch(this.error);
    }

    // Trigger: loan_expiring and loan_expired
    for (const [loanKey, loan] of currentLoans) {
      const previousLoan = this._previousLoans.get(loanKey);

      // Check if loan just crossed the warning threshold
      if (!previousLoan || (previousLoan.daysLeft > warningThreshold && loan.daysLeft <= warningThreshold)) {
        // Only trigger if this is a new transition (not on every poll)
        if (loan.daysLeft <= warningThreshold && loan.daysLeft >= 0) {
          this.log(`Loan expiring soon: ${loan.title} (${loan.daysLeft} days)`);

          const loanExpiringTrigger = this.homey.flow.getDeviceTriggerCard('loan_expiring');
          await loanExpiringTrigger.trigger(this, {
            book_title: loan.title,
            days_left: loan.daysLeft,
            library_name: loan.libraryName,
            user_name: loan.userName
          }, {
            days_left: loan.daysLeft // For runListener filtering
          }).catch(this.error);
        }
      }

      // Check if loan just became overdue
      if ((!previousLoan && loan.daysLeft < 0) ||
          (previousLoan && previousLoan.daysLeft >= 0 && loan.daysLeft < 0)) {
        this.log(`Loan overdue: ${loan.title} (${Math.abs(loan.daysLeft)} days overdue)`);

        const loanExpiredTrigger = this.homey.flow.getDeviceTriggerCard('loan_expired');
        await loanExpiredTrigger.trigger(this, {
          book_title: loan.title,
          days_overdue: Math.abs(loan.daysLeft),
          library_name: loan.libraryName
        }).catch(this.error);
      }
    }
  }

  /**
   * Calculate days remaining from due date string
   * @param {string} dueDateStr - Due date in DD/MM/YYYY format
   * @returns {number} Days remaining (negative if overdue)
   */
  _calculateDaysRemaining(dueDateStr) {
    if (!dueDateStr) return 0;

    try {
      // Try DD/MM/YYYY format first
      const parts = dueDateStr.split('/');
      let dueDate;

      if (parts.length === 3) {
        const [day, month, year] = parts.map(Number);
        dueDate = new Date(year, month - 1, day);
      } else {
        // Try ISO format
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

  /**
   * Build a summary string showing who has which books
   * @param {Map} currentLoans - Map of all loans
   * @param {Object} userDetails - User details from API
   * @returns {string} Formatted summary
   */
  _buildLoansSummary(currentLoans, userDetails) {
    // Group loans by user
    const loansByUser = new Map();

    for (const loan of currentLoans.values()) {
      const userName = loan.userName || 'Unknown';
      if (!loansByUser.has(userName)) {
        loansByUser.set(userName, []);
      }
      loansByUser.get(userName).push(loan);
    }

    // Build summary string
    const lines = [];

    for (const [userName, loans] of loansByUser) {
      // Sort loans by days remaining (urgent first)
      loans.sort((a, b) => a.daysLeft - b.daysLeft);

      lines.push(`${userName} (${loans.length}):`);

      for (const loan of loans) {
        const daysStr = loan.daysLeft < 0
          ? `${Math.abs(loan.daysLeft)}d overdue!`
          : `${loan.daysLeft}d`;
        const extendable = loan.isExtendable ? '' : ' [!]';
        lines.push(`  - ${loan.title} (${daysStr})${extendable}`);
      }
    }

    // Limit to ~500 chars for capability display
    let summary = lines.join('\n');
    if (summary.length > 500) {
      summary = summary.substring(0, 497) + '...';
    }

    return summary || 'No loans';
  }

  /**
   * Extract library name from URL
   */
  _extractLibraryFromUrl(url) {
    if (!url) return null;
    try {
      const hostname = new URL(url).hostname;
      const name = hostname.split('.')[0];
      return name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
      return null;
    }
  }

  /**
   * Extend all loans that meet the criteria
   * @param {number} maxDays - Maximum days remaining to extend
   * @returns {Promise<boolean>} Success status
   */
  async extendAllLoans(maxDays) {
    this.log(`Extending loans with ${maxDays} or fewer days remaining...`);

    try {
      const data = await this.getStoreValue('lastData');
      if (!data || !data.userDetails) {
        this.log('No loan data available');
        return false;
      }

      let totalExtended = 0;

      // Group loans by account for batch extension
      for (const [userId, user] of Object.entries(data.userDetails)) {
        if (!user.loanDetails) continue;

        const loansToExtend = [];
        const baseUrl = user.loans?.url?.replace(/\/loans$/, '') || '';

        for (const [key, loan] of Object.entries(user.loanDetails)) {
          if (loan.isExtendable &&
              loan.extendLoanId &&
              loan.daysRemaining <= maxDays) {
            loansToExtend.push(loan.extendLoanId);
          }
        }

        if (loansToExtend.length > 0 && baseUrl) {
          this.log(`Extending ${loansToExtend.length} loans for account ${userId}`);

          const count = await this.api.extendLoans(baseUrl, loansToExtend);
          totalExtended += count;
        }
      }

      this.log(`Extended ${totalExtended} loans total`);

      // Refresh data after extensions
      if (totalExtended > 0) {
        // Wait a bit for the server to process
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.refreshData();
      }

      return totalExtended > 0;
    } catch (error) {
      this.error('Failed to extend loans:', error);
      return false;
    }
  }

  async onDeleted() {
    this.log('Device deleted');

    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
    }
  }

}

module.exports = LibraryAccountDevice;
