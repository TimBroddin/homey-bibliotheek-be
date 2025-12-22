'use strict';

const fetch = require('node-fetch');
const { CookieJar } = require('tough-cookie');
const fetchCookieModule = require('fetch-cookie');
const fetchCookie = fetchCookieModule.default || fetchCookieModule;
const cheerio = require('cheerio');

const TIMEOUT = 30000;

/**
 * API client for bibliotheek.be
 * Ported from Python utils.py in the Home Assistant integration
 */
class BibliotheekAPI {

  constructor(homey) {
    this.homey = homey;
    this.cookieJar = new CookieJar();
    this.fetch = fetchCookie(fetch, this.cookieJar);
    this.baseHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/html, application/xhtml+xml',
      'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8'
    };
    this.authenticated = false;
    this.userdetails = {};
  }

  /**
   * Extract library name from URL hostname
   * @param {string} url - Library URL
   * @returns {string} Library name
   */
  static extractLibraryNameFromUrl(url) {
    try {
      const hostname = new URL(url).hostname;
      return hostname.split('.')[0];
    } catch {
      return 'unknown';
    }
  }

  /**
   * Convert repeated digits to spoken format (e.g., "122255" -> ["1", "3x2", "2x5"])
   * @param {string} inputString - String of digits
   * @returns {string[]} Array of spoken digit groups
   */
  static countRepeatedNumbers(inputString) {
    const counts = [];
    let currentChar = null;
    let currentCount = 0;

    for (const char of inputString) {
      if (char === currentChar) {
        currentCount++;
      } else {
        if (currentCount > 1) {
          counts.push(`${currentCount}x${currentChar}`);
        } else if (currentChar !== null) {
          counts.push(currentChar);
        }
        currentChar = char;
        currentCount = 1;
      }
    }

    if (currentCount > 1) {
      counts.push(`${currentCount}x${currentChar}`);
    } else if (currentChar !== null) {
      counts.push(currentChar);
    }

    return counts;
  }

  /**
   * Authenticate with bibliotheek.be using OAuth2-like flow
   * @param {string} username - Email address
   * @param {string} password - Password
   * @returns {Promise<boolean>} True if authentication successful
   */
  async login(username, password) {
    this.log('Starting authentication...');

    // Step 1: Get OAuth parameters from /mijn-bibliotheek/aanmelden
    const authStartResponse = await this.fetch(
      'https://bibliotheek.be/mijn-bibliotheek/aanmelden',
      {
        headers: { ...this.baseHeaders, 'Content-Type': 'application/json' },
        redirect: 'manual',
        timeout: TIMEOUT
      }
    );

    this.log(`Auth start status: ${authStartResponse.status}`);

    // If not redirected (302), already authenticated
    if (authStartResponse.status !== 302) {
      this.authenticated = true;
      this.log('Already authenticated');
      return true;
    }

    const oauthLocation = authStartResponse.headers.get('location');
    if (!oauthLocation) {
      throw new Error('No OAuth location in response');
    }

    // Parse OAuth parameters
    const oauthUrl = new URL(oauthLocation);
    const oauthCallback = oauthUrl.searchParams.get('oauth_callback');
    const oauthToken = oauthUrl.searchParams.get('oauth_token');
    const hint = oauthUrl.searchParams.get('hint');

    this.log(`OAuth params: hint=${hint}, token=${oauthToken ? 'present' : 'missing'}`);

    // Step 2: Get authorization page
    await this.fetch(oauthLocation, {
      headers: this.baseHeaders,
      timeout: TIMEOUT
    });

    // Step 3: POST credentials to login endpoint
    const loginHeaders = {
      ...this.baseHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Host': 'mijn.bibliotheek.be',
      'Origin': 'https://bibliotheek.be',
      'Referer': oauthLocation
    };

    const loginData = new URLSearchParams({
      hint: hint || 'login',
      token: oauthToken || '',
      callback: 'https://bibliotheek.be/my-library/login/callback',
      email: username,
      password: password
    });

    const loginResponse = await this.fetch(
      'https://mijn.bibliotheek.be/openbibid/rest/auth/login',
      {
        method: 'POST',
        headers: loginHeaders,
        body: loginData.toString(),
        redirect: 'manual',
        timeout: TIMEOUT
      }
    );

    this.log(`Login response status: ${loginResponse.status}`);

    if (loginResponse.status !== 200 && loginResponse.status !== 303) {
      throw new Error(`Login failed with status ${loginResponse.status}`);
    }

    // Step 4: Follow callback redirect
    if (loginResponse.status === 303) {
      const loginLocation = loginResponse.headers.get('location');
      if (loginLocation) {
        const callbackResponse = await this.fetch(loginLocation, {
          headers: this.baseHeaders,
          redirect: 'manual',
          timeout: TIMEOUT
        });

        this.log(`Callback response status: ${callbackResponse.status}`);

        // If redirected again, need to get access token
        if (callbackResponse.status === 302) {
          await this.fetch(
            'https://mijn.bibliotheek.be/openbibid/rest/accessToken',
            {
              method: 'POST',
              headers: loginHeaders,
              body: loginData.toString(),
              redirect: 'follow',
              timeout: TIMEOUT
            }
          );
        }
      }
    }

    // Step 5: Verify authentication by accessing memberships page
    const verifyResponse = await this.fetch(
      'https://bibliotheek.be/mijn-bibliotheek/lidmaatschappen',
      {
        headers: this.baseHeaders,
        redirect: 'manual',
        timeout: TIMEOUT
      }
    );

    if (verifyResponse.status !== 200) {
      throw new Error('Authentication verification failed');
    }

    this.authenticated = true;
    this.log('Authentication successful');
    return true;
  }

  /**
   * Get all library memberships
   * @returns {Promise<Object>} Memberships data
   */
  async getMemberships() {
    const response = await this.fetch(
      'https://bibliotheek.be/api/my-library/memberships',
      {
        headers: this.baseHeaders,
        redirect: 'follow',
        timeout: TIMEOUT
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch memberships: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get activities (loan/reservation counts) for a specific account
   * @param {string} accountId - Account ID
   * @returns {Promise<Object>} Activities data
   */
  async getActivities(accountId) {
    const response = await this.fetch(
      `https://bibliotheek.be/api/my-library/${accountId}/activities`,
      {
        headers: this.baseHeaders,
        redirect: 'follow',
        timeout: TIMEOUT
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch activities: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get all loans overview (JSON API)
   * @returns {Promise<Array>} Loans array
   */
  async getLoans() {
    const response = await this.fetch(
      'https://bibliotheek.be/my-library-overview-loans',
      {
        headers: this.baseHeaders,
        redirect: 'follow',
        timeout: TIMEOUT
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch loans: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get all reservations (JSON API)
   * @returns {Promise<Array>} Reservations array
   */
  async getReservations() {
    const response = await this.fetch(
      'https://bibliotheek.be/my-library-overview-reservations',
      {
        headers: this.baseHeaders,
        redirect: 'follow',
        timeout: TIMEOUT
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch reservations: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get detailed loan information from HTML page (includes extend_loan_id)
   * @param {string} url - Loans page URL
   * @returns {Promise<Object>} Loan details keyed by title+extend_loan_id
   */
  async getLoanDetails(url) {
    const loanDetails = {};

    this.log(`Fetching loan details from: ${url}`);

    // Extract account ID from URL
    const accountIdMatch = url.match(/\/memberships\/(\d+)\//);
    const accountId = accountIdMatch ? accountIdMatch[1] : null;

    const response = await this.fetch(url, {
      headers: this.baseHeaders,
      redirect: 'follow',
      timeout: TIMEOUT
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch loan details: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Find all loan wrappers
    const libs = $('.my-library-user-library-account-loans__loan-wrapper');

    libs.each((_, libDiv) => {
      const books = $(libDiv).find('.my-library-user-library-account-loans__loan');

      books.each((_, bookEl) => {
        const $book = $(bookEl);

        // Extract library name from title link
        let libName = '';
        try {
          const href = $book.find('.my-library-user-library-account-loans__loan-title a').attr('href');
          if (href) {
            libName = href.split('.')[0].split('//')[1];
            libName = libName.charAt(0).toUpperCase() + libName.slice(1);
          }
        } catch { /* ignore */ }

        // Extract title
        const title = $book.find('.my-library-user-library-account-loans__loan-title a').text().trim() || '';

        // Extract URL
        const itemUrl = $book.find('.my-library-user-library-account-loans__loan-title a').attr('href') || '';

        // Extract cover image
        const imageSrc = $book.find('.my-library-user-library-account-loans__loan-cover-img').attr('src') || '';

        // Extract author
        const author = $book.find('.author').text().trim() || '';

        // Extract loan type
        const loanType = $book.find('.my-library-user-library-account-loans__loan-type-label').text().trim() || 'Unknown';

        // Extract loan from/till dates
        const loanFromTo = $book.find('.my-library-user-library-account-loans__loan-from-to');
        const loanFrom = loanFromTo.find('> div > span:nth-of-type(2)').text().trim() || '';
        const loanTill = loanFromTo.find('> div:nth-of-type(2) > span:nth-of-type(2)').text().trim() || '';

        // Extract days remaining
        let daysRemaining = 0;
        const daysText = $book.find('.my-library-user-library-account-loans__loan-days').text().trim();
        if (daysText) {
          const daysMatch = daysText.toLowerCase()
            .replace('nog ', '')
            .replace(' dagen', '')
            .replace(' dag', '')
            .trim();
          daysRemaining = parseInt(daysMatch, 10) || 0;
        }

        // Extract extend_loan_id from checkbox
        let extendLoanId = '';
        try {
          const checkbox = $book.find('.my-library-user-library-account-loans__extend-loan input[type="checkbox"]');
          extendLoanId = checkbox.attr('id') || '';
        } catch { /* ignore */ }

        // Build key and store details
        const key = `${title}${extendLoanId}`;
        loanDetails[key] = {
          title,
          author,
          loanType,
          url: itemUrl,
          imageSrc,
          daysRemaining,
          loanFrom,
          loanTill,
          extendLoanId,
          library: libName,
          accountId,
          isExtendable: !!extendLoanId
        };
      });
    });

    this.log(`Found ${Object.keys(loanDetails).length} loan details`);
    return loanDetails;
  }

  /**
   * Get library details from HTML page
   * @param {string} url - Library URL (will append /adres-en-openingsuren)
   * @returns {Promise<Object>} Library details
   */
  async getLibraryDetails(url) {
    const detailsUrl = url.includes('/adres-en-openingsuren')
      ? url
      : `${url}/adres-en-openingsuren`;

    this.log(`Fetching library details from: ${detailsUrl}`);

    const response = await this.fetch(detailsUrl, {
      headers: this.baseHeaders,
      redirect: 'follow',
      timeout: TIMEOUT
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    const libraryInfo = {
      url: url.replace('/adres-en-openingsuren', ''),
      libraryNameFromUrl: BibliotheekAPI.extractLibraryNameFromUrl(url)
    };

    const article = $('.library.library--page-item');
    if (!article.length) {
      this.log('No library article found');
      return libraryInfo;
    }

    // Parse opening hours
    const hours = {};
    article.find('.library__date-open').each((_, dl) => {
      const day = $(dl).find('dt').text().trim();
      const times = [];
      $(dl).find('.timespan time').each((_, time) => {
        times.push($(time).text().trim());
      });
      hours[day] = times;
    });
    libraryInfo.hours = hours;

    // Parse GPS coordinates
    const gpsEl = article.find('.library__pane--address-address--gps');
    if (gpsEl.length) {
      const gpsText = gpsEl.text()
        .replace(/\n/g, ' ')
        .replace('\u00b0', '')
        .replace('Gps', '')
        .trim();
      const parts = gpsText.split('NB');
      if (parts.length >= 2) {
        libraryInfo.lat = parts[0].trim();
        libraryInfo.lon = parts[1].split('OL')[0].trim();
      }
    }

    // Parse address
    const addressEl = article.find('.library__pane--address--address');
    if (addressEl.length) {
      libraryInfo.address = addressEl.text()
        .replace(/\n/g, ' ')
        .replace('Adres', '')
        .replace('Toon op kaart', '')
        .trim()
        .replace(/\s{2,}/g, ', ');
    }

    // Parse phone
    const phoneEl = article.find('a.tel');
    if (phoneEl.length) {
      libraryInfo.phone = phoneEl.text().trim();
    }

    // Parse email
    const emailEl = article.find('.spamspan');
    if (emailEl.length) {
      libraryInfo.email = emailEl.text().trim().replace(' [at] ', '@');
    }

    // Parse closed dates
    const closedDates = [];
    article.find('.library__date-closed').each((_, dl) => {
      const date = $(dl).find('dt').text().trim();
      const reason = $(dl).find('dd').text().trim();
      closedDates.push({ date, reason });
    });
    libraryInfo.closedDates = closedDates;

    return libraryInfo;
  }

  /**
   * Get user's personal book lists
   * @returns {Promise<Object>} Lists keyed by list ID
   */
  async getUserLists() {
    const listDetails = {};

    const response = await this.fetch(
      'https://bibliotheek.be/mijn-bibliotheek/lijsten',
      {
        headers: this.baseHeaders,
        redirect: 'follow',
        timeout: TIMEOUT
      }
    );

    if (!response.ok) {
      this.log(`Failed to fetch user lists: ${response.status}`);
      return listDetails;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Find the Vue.js tag with list data
    const tag = $('item-lists-overview');
    const listsJson = tag.attr(':lists');

    if (!listsJson) {
      this.log('No lists data found');
      return listDetails;
    }

    try {
      const data = JSON.parse(listsJson);

      for (const item of data) {
        const listId = item.url.split('/').pop();

        listDetails[listId] = {
          id: listId,
          name: item.title,
          url: `https://bibliotheek.be${item.url}`,
          numItems: item.numberOfItems,
          lastChanged: item.modifiedDate
        };

        // Fetch list items
        try {
          const itemsResponse = await this.fetch(
            `https://bibliotheek.be/my-library/list/${listId}/list-items?items_per_page=300&status=1`,
            {
              headers: this.baseHeaders,
              redirect: 'follow',
              timeout: TIMEOUT
            }
          );

          if (itemsResponse.ok) {
            const listItems = await itemsResponse.json();
            listDetails[listId].items = listItems.map(listItem => ({
              title: listItem.title || '',
              author: listItem.author || '',
              url: listItem.url || '',
              cover: listItem.cover || '',
              id: listItem.id || ''
            }));
          }
        } catch (err) {
          this.log(`Failed to fetch items for list ${listId}: ${err.message}`);
        }
      }
    } catch (err) {
      this.log(`Failed to parse lists JSON: ${err.message}`);
    }

    return listDetails;
  }

  /**
   * Extend multiple loans by their IDs
   * @param {string} baseUrl - Base URL for the account's loans page
   * @param {string[]} extendLoanIds - Array of extend_loan_id values
   * @returns {Promise<number>} Number of loans extended
   */
  async extendLoans(baseUrl, extendLoanIds) {
    if (!extendLoanIds || extendLoanIds.length === 0) {
      return 0;
    }

    // Build extension URL
    const extendUrl = `${baseUrl}/extend?loan-ids=${extendLoanIds.join('%2C')}`;

    this.log(`Extending loans: ${extendUrl}`);

    // Get extension form
    const response = await this.fetch(extendUrl, {
      headers: this.baseHeaders,
      redirect: 'manual',
      timeout: TIMEOUT
    });

    if (!response.ok && response.status !== 200) {
      throw new Error(`Failed to get extension form: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Find the extension form
    const form = $('.my-library-extend-loan-form');
    if (!form.length) {
      this.log('No extension form found');
      return 0;
    }

    // Extract form data
    const formData = new URLSearchParams();
    form.find('input').each((_, input) => {
      const name = $(input).attr('name');
      const value = $(input).attr('value');
      if (name) {
        formData.append(name, value || '');
      }
    });

    // Submit extension
    const confirmResponse = await this.fetch(extendUrl, {
      method: 'POST',
      headers: {
        ...this.baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString(),
      redirect: 'follow',
      timeout: TIMEOUT
    });

    this.log(`Extension confirmation status: ${confirmResponse.status}`);

    return extendLoanIds.length;
  }

  /**
   * Full data refresh - fetches all data and aggregates it
   * @param {string} username - Email address
   * @param {string} password - Password
   * @returns {Promise<Object>} Complete data object
   */
  async refreshAllData(username, password) {
    // Ensure authenticated
    await this.login(username, password);

    // Fetch memberships
    const memberships = await this.getMemberships();
    this.log(`Fetched memberships: ${JSON.stringify(Object.keys(memberships))}`);

    // Fetch loans and reservations from overview APIs
    const loans = await this.getLoans();
    const reservations = await this.getReservations();

    this.log(`Fetched ${loans.length} loans and ${reservations.length} reservations`);

    // Process memberships and get per-account details
    const userDetails = {};
    const libraryDetails = {};

    for (const [regionName, regionType] of Object.entries(memberships)) {
      const libraryAccounts = regionType.library || regionType.region || [];

      // Handle both array and object formats
      let accounts = [];
      if (Array.isArray(libraryAccounts)) {
        accounts = libraryAccounts;
      } else if (typeof libraryAccounts === 'object') {
        for (const accountList of Object.values(libraryAccounts)) {
          if (Array.isArray(accountList)) {
            accounts.push(...accountList);
          }
        }
      }

      for (const account of accounts) {
        if (!account.hasError && account.id) {
          // Get activities for this account
          const activities = await this.getActivities(account.id);

          // Build user details
          const libraryUrl = account.library || '';
          const libraryNameFromUrl = BibliotheekAPI.extractLibraryNameFromUrl(libraryUrl);

          userDetails[account.id] = {
            accountDetails: {
              ...account,
              barcodeSpell: BibliotheekAPI.countRepeatedNumbers(account.barcode || ''),
              userName: account.name || '',
              libraryLongName: account.libraryName || '',
              libraryName: libraryNameFromUrl.charAt(0).toUpperCase() + libraryNameFromUrl.slice(1)
            },
            loans: {
              count: activities.numberOfLoans || 0,
              url: `https://bibliotheek.be/my-library/memberships/${account.id}/loans`,
              historyUrl: `${libraryUrl}${activities.loanHistoryUrl || ''}`
            },
            reservations: {
              count: activities.numberOfHolds || 0,
              url: `https://bibliotheek.be/my-library/memberships/${account.id}/holds`
            },
            openAmounts: {
              amount: activities.openAmount || 0,
              url: `https://bibliotheek.be/my-library/memberships/${account.id}/pay`
            }
          };

          // Store library URL for later
          if (libraryUrl) {
            libraryDetails[libraryNameFromUrl] = libraryUrl;
          }

          // Get detailed loan information if there are loans
          if (activities.numberOfLoans > 0) {
            try {
              const loanDetails = await this.getLoanDetails(
                userDetails[account.id].loans.url
              );
              userDetails[account.id].loanDetails = loanDetails;
            } catch (err) {
              this.log(`Failed to get loan details for ${account.id}: ${err.message}`);
            }
          }
        }
      }
    }

    // Try to fetch user lists (non-critical)
    let userLists = {};
    try {
      userLists = await this.getUserLists();
    } catch (err) {
      this.log(`Failed to fetch user lists: ${err.message}`);
    }

    return {
      userDetails,
      loans,
      reservations,
      libraryDetails,
      userLists,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Log helper
   * @param {string} message - Message to log
   */
  log(message) {
    if (this.homey) {
      this.homey.log(`[BibliotheekAPI] ${message}`);
    } else {
      console.log(`[BibliotheekAPI] ${message}`);
    }
  }

}

module.exports = BibliotheekAPI;
