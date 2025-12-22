'use strict';

module.exports = {
  async getLoans({ homey, query }) {
    const deviceId = query.deviceId;

    if (!deviceId) {
      return { error: 'No device selected', loans: [] };
    }

    try {
      // Get all devices from library-account driver
      const devices = homey.drivers.getDriver('library-account').getDevices();

      // Homey.getDeviceIds() returns internal Homey device IDs, not our custom data.id
      // We need to match against the device's internal ID
      const device = devices.find(d => {
        // Try matching against Homey's internal ID (from __id or similar)
        const homeyId = d.__id || d.id || '';
        const dataId = d.getData()?.id || '';
        return homeyId === deviceId || dataId === deviceId;
      });

      if (!device) {
        homey.log(`Widget: Device not found. Looking for: ${deviceId}`);
        homey.log(`Widget: Available devices: ${devices.map(d => `${d.__id || d.id} (data.id: ${d.getData()?.id})`).join(', ')}`);
        return { error: 'Device not found', loans: [] };
      }

      // Get stored data from device
      const storedData = await device.getStoreValue('lastData');

      if (!storedData) {
        return { error: 'No data available yet', loans: [] };
      }

      // Transform loans data for the widget
      const loans = [];
      const { userDetails } = storedData;

      for (const [userId, user] of Object.entries(userDetails || {})) {
        const userName = user.accountDetails?.userName || 'Unknown';
        const libraryName = user.accountDetails?.libraryName || 'Unknown';

        // Get loan details if available
        if (user.loanDetails) {
          for (const [key, loan] of Object.entries(user.loanDetails)) {
            loans.push({
              title: loan.title || 'Unknown',
              author: loan.author || '',
              daysRemaining: loan.daysRemaining ?? 0,
              userName,
              libraryName: loan.library || libraryName,
              isExtendable: loan.isExtendable !== false,
              loanType: loan.loanType || 'Book',
              imageSrc: loan.imageSrc || null,
              loanFrom: loan.loanFrom || '',
              loanTill: loan.loanTill || ''
            });
          }
        }
      }

      // Sort by days remaining (urgent first)
      loans.sort((a, b) => a.daysRemaining - b.daysRemaining);

      return {
        loans,
        lastUpdated: storedData.lastUpdated || null
      };
    } catch (error) {
      homey.error('Widget API error:', error);
      return { error: error.message, loans: [] };
    }
  }
};
