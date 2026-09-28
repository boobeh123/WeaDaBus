exports.getHome = async (req, res) => {
  res.render('home', { title: null, error: null });
};
