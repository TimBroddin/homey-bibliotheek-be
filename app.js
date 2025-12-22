'use strict';

const Homey = require('homey');

class BibliotheekApp extends Homey.App {

  async onInit() {
    this.log('Bibliotheek.be app has been initialized');

    // Register global flow cards that aren't device-specific
    this._registerFlowCards();
  }

  _registerFlowCards() {
    // Flow cards are registered per-driver in driver.js
    // This method is for any app-level flow cards if needed
    this.log('Flow cards will be registered by drivers');
  }

}

module.exports = BibliotheekApp;
