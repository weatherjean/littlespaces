fn weather(input) {
    let response = http_read("weather");
    #{ temperatureC: response.current.temperature_2m, observedAt: response.current.time }
}
