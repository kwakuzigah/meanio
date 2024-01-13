'use strict';
var Schema = mongoose.Schema;

/**
 * Module dependencies.
 */

module.exports = function(database) {
  /**
   * Package Schema
   */
  var PackageSchema = new Schema({
    name: String,
    settings: {},
    updated: {
      type: Date,
      default: Date.now
    }
  });

  database.connection.model('Package', PackageSchema);
};
