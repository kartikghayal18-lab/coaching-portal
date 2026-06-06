const path = require('path');

function buildProgressSummaryFromPapers(papers) {
  const markedPapers = (papers || [])
    .filter((paper) => paper.marks_obtained !== null && paper.max_marks !== null && Number(paper.max_marks) > 0)
    .slice()
    .reverse();

  const totalMarksObtained = markedPapers.reduce((sum, paper) => sum + Number(paper.marks_obtained || 0), 0);
  const totalMaxMarks = markedPapers.reduce((sum, paper) => sum + Number(paper.max_marks || 0), 0);
  const marksPercent = totalMaxMarks
    ? ((totalMarksObtained / totalMaxMarks) * 100).toFixed(2)
    : '0.00';

  const progressSeries = markedPapers.map((paper, index) => ({
    label: paper.test_label || path.parse(paper.original_name || 'Test').name,
    marks: Number(paper.marks_obtained),
    max: Number(paper.max_marks),
    percent: Number(((Number(paper.marks_obtained) / Number(paper.max_marks)) * 100).toFixed(1)),
    testNo: index + 1,
  }));

  return {
    markedPapers,
    progressSeries,
    marksSummary: {
      testsCount: markedPapers.length,
      totalMarksObtained,
      totalMaxMarks,
      marksPercent,
    },
  };
}

module.exports = {
  buildProgressSummaryFromPapers,
};
